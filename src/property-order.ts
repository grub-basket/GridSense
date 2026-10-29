import { App, TFile } from "obsidian";

/**
 * Frontmatter KEY ORDER: the shared core behind every "reorder properties"
 * surface (one note's property editor, the bulk "Reorder properties" modal,
 * and the undo/redo of both). YAML key order is the stored order, so a
 * reorder rewrites the whole block with the same values in a new sequence.
 * Values never change and nothing extra is written into the note.
 */

/** What happens to keys the chosen order doesn't mention. */
export type UnlistedMode = "after" | "in-place";

/** A saved, named property order (plugin settings + the shared export format). */
export interface PropertyOrderPreset {
  name: string;
  keys: string[];
  unlisted: UnlistedMode;
}

/** Keys we never manage: writing them back would touch the object prototype. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Clean a user-supplied key list: trimmed, non-empty, safe, first occurrence wins. */
export function cleanKeyList(keys: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    if (typeof raw !== "string") continue;
    const k = raw.trim();
    if (!k || UNSAFE_KEYS.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * The order a note's keys should end up in.
 * - "after": listed keys first (list order, only those the note has), then
 *   every other key in its existing relative order.
 * - "in-place": unlisted keys keep their slots; the slots that listed keys
 *   occupied are refilled with those same keys in list order.
 * A note missing a listed key simply skips it.
 */
export function orderKeys(current: string[], listed: string[], mode: UnlistedMode): string[] {
  const listedSet = new Set(listed);
  const has = new Set(current);
  const present = listed.filter((k) => has.has(k));
  if (mode === "in-place") {
    let j = 0;
    return current.map((k) => (listedSet.has(k) ? present[j++] : k));
  }
  return [...present, ...current.filter((k) => !listedSet.has(k))];
}

export function sameKeyOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** A note's frontmatter keys in stored order, from the metadata cache. */
export function cachedKeys(app: App, file: TFile): string[] {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  return fm ? Object.keys(fm) : [];
}

/**
 * Rebuild one note's frontmatter so its keys follow `order` exactly. Keys in
 * `order` the note doesn't have are skipped; keys the note has that `order`
 * doesn't mention (added behind our back by a sync or another plugin) keep
 * their value and land after the known keys rather than vanishing.
 * Deliberately NOT short-circuited from the metadata cache: right after a
 * reorder the cache can still show the old order, and an undo judged from it
 * would think "already done" and silently skip. The real keys are checked
 * inside processFrontMatter instead (Obsidian only writes when the text
 * actually changes). Returns the order written (null when unchanged).
 */
export async function writeKeyOrder(
  app: App,
  file: TFile,
  order: string[]
): Promise<string[] | null> {
  let written: string[] | null = null;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const current = Object.keys(fm);
    const next = arrange(current, order);
    if (sameKeyOrder(next, current)) return;
    rebuild(fm, next);
    written = next;
  });
  return written;
}

/**
 * `order`'s keys that `current` has, then the rest of `current` in place.
 * Matched EXACTLY (de-duplicated only): `order` comes from a note's own keys
 * (undo/redo, single-note moves), so cleaning it like user input would drop
 * a real key such as `prototype` or a padded name and push it to the end.
 */
function arrange(current: string[], order: string[]): string[] {
  const has = new Set(current);
  const known = [...new Set(order)].filter((k) => has.has(k));
  const knownSet = new Set(known);
  return [...known, ...current.filter((k) => !knownSet.has(k))];
}

/** Re-insert every key of `fm` in `next` order; values untouched. */
function rebuild(fm: Record<string, unknown>, next: string[]) {
  const kept: [string, unknown][] = [];
  for (const k of next) if (hasOwn(fm, k)) kept.push([k, fm[k]]);
  for (const k of Object.keys(fm)) delete fm[k];
  for (const [k, v] of kept) fm[k] = v;
}

/** One note that a reorder will (or did) change. */
export interface ReorderChange {
  path: string;
  before: string[];
  after: string[];
}

/** Which of `files` a reorder would change, judged from the metadata cache. */
export function planReorder(
  app: App,
  files: TFile[],
  listed: string[],
  mode: UnlistedMode
): TFile[] {
  const keys = cleanKeyList(listed);
  if (!keys.length) return [];
  return files.filter((f) => {
    const cur = cachedKeys(app, f);
    return cur.length > 1 && !sameKeyOrder(orderKeys(cur, keys, mode), cur);
  });
}

/**
 * Apply a list order to many notes. The target order is recomputed inside
 * processFrontMatter from the note's real keys (the cache can lag), and notes
 * already in order are left unwritten. Returns what changed so the caller can
 * register ONE undo step for the whole batch.
 */
export async function applyReorder(
  app: App,
  files: TFile[],
  listed: string[],
  mode: UnlistedMode,
  progress?: (done: number, of: number) => void
): Promise<{ changes: ReorderChange[]; failed: string[] }> {
  const keys = cleanKeyList(listed);
  const changes: ReorderChange[] = [];
  const failed: string[] = [];
  let done = 0;
  for (const file of files) {
    try {
      await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const before = Object.keys(fm);
        const after = orderKeys(before, keys, mode);
        if (sameKeyOrder(after, before)) return;
        rebuild(fm, after);
        changes.push({ path: file.path, before, after });
      });
    } catch {
      failed.push(file.path);
    }
    progress?.(++done, files.length);
    // Yield now and then so a vault-wide run doesn't freeze the window.
    if (done % 25 === 0) await new Promise((r) => window.setTimeout(r, 0));
  }
  return { changes, failed };
}

/**
 * Write each change's `before` (undo) or `after` (redo) order back. Returns
 * how many notes were rewritten and which paths could not be found or read
 * (renamed, moved or deleted since), so the caller can say so.
 */
export async function replayReorder(
  app: App,
  changes: ReorderChange[],
  side: "before" | "after",
  progress?: (done: number, of: number) => void
): Promise<{ written: number; missing: string[] }> {
  let written = 0;
  const missing: string[] = [];
  let done = 0;
  for (const c of changes) {
    const file = app.vault.getAbstractFileByPath(c.path);
    if (file instanceof TFile) {
      try {
        if (await writeKeyOrder(app, file, c[side])) written++;
      } catch {
        // One unreadable note must not strand the rest of the batch.
        missing.push(c.path);
      }
    } else missing.push(c.path);
    progress?.(++done, changes.length);
    if (done % 25 === 0) await new Promise((r) => window.setTimeout(r, 0));
  }
  return { written, missing };
}

/** Key → number of `files` that have it, plus first-seen order for ties. */
export function keyCounts(app: App, files: TFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of files)
    for (const k of cachedKeys(app, f)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts;
}

// ------------------------------------------------------------ shared format

/**
 * The export format, identical in GridSense and Bases Toolbox so a file
 * exported from one imports into the other:
 * { "format": "property-orders", "version": 1, "orders": [ { name, keys, unlisted } ] }
 */
export const ORDERS_FORMAT = "property-orders";
export const ORDERS_VERSION = 1;

export function serializeOrders(orders: PropertyOrderPreset[]): string {
  return JSON.stringify(
    {
      format: ORDERS_FORMAT,
      version: ORDERS_VERSION,
      orders: orders.map((o) => ({ name: o.name, keys: o.keys.slice(), unlisted: o.unlisted })),
    },
    null,
    2
  );
}

export type ParsedOrders = { ok: true; orders: PropertyOrderPreset[] } | { ok: false; error: string };

/** Parse an export. Anything not exactly this format + version is rejected. */
export function parseOrders(text: string): ParsedOrders {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "that isn't valid JSON." };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ok: false, error: "expected a JSON object." };
  const d = data as Record<string, unknown>;
  if (d.format !== ORDERS_FORMAT)
    return {
      ok: false,
      error: `not a property-orders export (format is ${JSON.stringify(d.format ?? null)}, expected "${ORDERS_FORMAT}").`,
    };
  if (d.version !== ORDERS_VERSION)
    return {
      ok: false,
      error: `unsupported property-orders version ${JSON.stringify(d.version ?? null)} (this version of GridSense reads version ${ORDERS_VERSION}).`,
    };
  if (!Array.isArray(d.orders)) return { ok: false, error: `"orders" must be a list.` };
  const out: PropertyOrderPreset[] = [];
  const names = new Set<string>();
  for (const [i, raw] of d.orders.entries()) {
    if (!raw || typeof raw !== "object") return { ok: false, error: `order #${i + 1} isn't an object.` };
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) return { ok: false, error: `order #${i + 1} has no name.` };
    if (!Array.isArray(o.keys)) return { ok: false, error: `order "${name}" has no "keys" list.` };
    const unlisted = o.unlisted === undefined ? "after" : o.unlisted;
    if (unlisted !== "after" && unlisted !== "in-place")
      return {
        ok: false,
        error: `order "${name}" has unlisted ${JSON.stringify(unlisted)} (expected "after" or "in-place").`,
      };
    if (names.has(name)) return { ok: false, error: `the name "${name}" appears twice.` };
    names.add(name);
    out.push({ name, keys: cleanKeyList(o.keys), unlisted });
  }
  return { ok: true, orders: out };
}
