import { AbstractInputSuggest, App, TFile, TFolder, getAllTags } from "obsidian";
import { valueToDisplay } from "./edits";

/**
 * One shared autocomplete for every text box in GridSense.
 *
 * Every field that names a vault entity (folder, note, tag, property key,
 * property value, heading, saved view…) gets a `FieldSuggest` wired to one of
 * the sources below. It grew out of the old `ListSuggest` (formula builder),
 * which is now a thin alias over this class so existing call sites keep
 * working.
 *
 * Behaviour, in one place:
 * - Matching is multi-token, order-independent and case-insensitive; exact
 *   and prefix hits rank above mid-word hits, ties keep the source's order
 *   (sources pre-sort by frequency or name).
 * - Sources are LAZY and cached per focus: nothing is scanned until the field
 *   is focused/typed in, and the scan is dropped again on blur so the next
 *   visit sees fresh vault data.
 * - Free text always stays allowed — suggestions never force a value.
 * - Picking commits the same way typing would: the value is written, an
 *   `input` event fires (so `onChange` / save logic runs), then it closes.
 * - `span` lets a field complete only PART of its text: the current item of a
 *   comma list, or the `[[link` being typed. Only that slice is replaced.
 * - `plainEnter` is for fields where Enter already means "commit/submit"
 *   (grid cells, draft rows, property editors, add-row form). There, Enter
 *   only picks a suggestion once you've arrowed into the list; a plain Enter
 *   closes the list and runs the field's own Enter action with what you typed.
 *   Without it, a list opened on focus would silently swap your typing for
 *   its first entry.
 */

export interface SuggestItem {
  /** Text inserted into the field. */
  value: string;
  /** Shown instead of `value` (defaults to value). */
  label?: string;
  /** Secondary line, e.g. the full path when two notes share a name. */
  detail?: string;
}

/** The slice of the field a suggestion replaces. */
export interface Span {
  from: number;
  to: number;
  query: string;
  /** Lets one field switch sources, e.g. values vs. `[[links`. */
  kind?: string;
}

type Source = (kind: string) => (string | SuggestItem)[];

export interface FieldSuggestOptions {
  /** Max rows rendered; 0 = uncapped. Default 100. */
  limit?: number;
  /** Which part of the text to complete. Default: the whole value. Return null to stay quiet. */
  span?: (value: string, caret: number) => Span | null;
  /** Transform the picked value before it's inserted into the span. */
  insert?: (item: SuggestItem, span: Span) => string;
  /** Show the whole list when the query is empty. Default true. */
  openOnEmpty?: boolean | ((span: Span) => boolean);
  /**
   * The field's own Enter action. When set, a plain Enter (no arrowing into
   * the list first) closes the list and calls this instead of picking.
   */
  plainEnter?: (evt: KeyboardEvent) => void;
  /** Whether the plainEnter guard applies right now (default: always, when plainEnter is set). */
  guardEnter?: (span: Span) => boolean;
  /** Values to leave out (e.g. items already in the list being edited). */
  exclude?: () => string[];
}

const toItem = (x: string | SuggestItem): SuggestItem => (typeof x === "string" ? { value: x } : x);

/**
 * Rank items against a query: every whitespace-separated token must appear
 * (any order, case-insensitive). Exact > prefix > word-start > anywhere.
 */
export function rankItems(items: SuggestItem[], query: string): SuggestItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const tokens = q.split(/\s+/).filter(Boolean);
  const wordStart = new RegExp(`(^|[\\s/._-])${escapeRe(tokens[0])}`);
  const scored: { item: SuggestItem; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const main = (item.label ?? item.value).toLowerCase();
    const hay = item.detail ? `${main} ${item.detail.toLowerCase()}` : main;
    if (!tokens.every((t) => hay.includes(t))) return;
    let score = 3;
    if (main === q) score = 0;
    else if (main.startsWith(q)) score = 1;
    else if (wordStart.test(main)) score = 2;
    scored.push({ item, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.map((s) => s.item);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class FieldSuggest extends AbstractInputSuggest<SuggestItem> {
  private cache = new Map<string, SuggestItem[]>();
  private lastSpan: Span | null = null;
  /** Did the user arrow into the list since it last changed? */
  private navigated = false;
  private detachKeys: (() => void) | null = null;

  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private source: Source,
    private opts: FieldSuggestOptions = {}
  ) {
    super(app, inputEl);
    this.limit = opts.limit ?? 100;
    // Fresh data on each visit, without rescanning per keystroke.
    inputEl.addEventListener("blur", () => this.cache.clear());
  }

  private items(kind: string): SuggestItem[] {
    let items = this.cache.get(kind);
    if (!items) {
      items = this.source(kind).map(toItem);
      this.cache.set(kind, items);
    }
    return items;
  }

  getSuggestions(): SuggestItem[] {
    this.navigated = false;
    const el = this.inputEl;
    const value = el.value;
    const caret = el.selectionStart ?? value.length;
    const span = this.opts.span ? this.opts.span(value, caret) : { from: 0, to: value.length, query: value };
    this.lastSpan = span;
    if (!span) return [];
    const q = span.query.trim();
    const onEmpty = this.opts.openOnEmpty;
    if (!q && (typeof onEmpty === "function" ? !onEmpty(span) : onEmpty === false)) return [];
    let items = this.items(span.kind ?? "");
    const skip = this.opts.exclude?.();
    if (skip?.length) {
      const set = new Set(skip.map((s) => s.toLowerCase()));
      items = items.filter((i) => !set.has(i.value.toLowerCase()));
    }
    const lower = q.toLowerCase();
    const exact = q !== "" && items.some((i) => i.value.toLowerCase() === lower);
    if (exact) {
      // Already a known value. Guarded fields only offer longer matches
      // ("urg" → "urgent") and stay quiet otherwise, so opening an editor on
      // an existing value doesn't pop a list. A typed [[link keeps its exact
      // hit on top (Enter closes the brackets). Plain fields show everything,
      // so you can browse alternatives.
      if (this.opts.plainEnter && (this.opts.guardEnter?.(span) ?? true))
        return rankItems(items.filter((i) => i.value.toLowerCase() !== lower), q);
      if (span.kind) return rankItems(items, q);
      return items;
    }
    return rankItems(items, q);
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement): void {
    el.addClass("gridsense-suggest");
    el.createDiv({ cls: "gridsense-suggest-title", text: item.label ?? (item.value || "(vault root)") });
    if (item.detail) el.createDiv({ cls: "gridsense-suggest-detail", text: item.detail });
  }

  selectSuggestion(item: SuggestItem, evt: MouseEvent | KeyboardEvent): void {
    const span = this.lastSpan ?? { from: 0, to: this.inputEl.value.length, query: this.inputEl.value };
    if (
      this.opts.plainEnter &&
      evt?.type === "keydown" &&
      !this.navigated &&
      (this.opts.guardEnter?.(span) ?? true)
    ) {
      // Enter without choosing: keep what was typed and let the field act.
      this.close();
      this.opts.plainEnter(evt as KeyboardEvent);
      return;
    }
    const el = this.inputEl;
    const text = this.opts.insert ? this.opts.insert(item, span) : item.value;
    const value = el.value;
    el.value = value.slice(0, span.from) + text + value.slice(span.to);
    const caret = span.from + text.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input"));
    this.close();
  }

  open(): void {
    super.open();
    if (this.detachKeys || !this.opts.plainEnter) return;
    // Obsidian's keymap handles the list's arrow keys in the window's capture
    // phase and stops propagation there, so the input never sees them. A
    // capture listener on the same window still runs (stopPropagation doesn't
    // stop same-target listeners) — that's how we learn the user navigated.
    const win = this.inputEl.win;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") this.navigated = true;
    };
    win.addEventListener("keydown", onKey, true);
    this.detachKeys = () => win.removeEventListener("keydown", onKey, true);
  }

  close(): void {
    this.detachKeys?.();
    this.detachKeys = null;
    this.navigated = false;
    super.close();
  }
}

/** Back-compat: the original string-list suggest, now backed by FieldSuggest. */
export class ListSuggest extends FieldSuggest {
  constructor(app: App, inputEl: HTMLInputElement, itemsFn: () => (string | SuggestItem)[], opts: FieldSuggestOptions = {}) {
    super(app, inputEl, () => itemsFn(), { limit: 0, ...opts });
  }
}

// ------------------------------------------------------------------- spans

/**
 * Complete the current item of a comma-separated list (the one the caret is
 * in). Leading spaces after the comma aren't part of the item.
 */
export function listSpan(value: string, caret: number): Span {
  const start = value.lastIndexOf(",", caret - 1) + 1;
  let end = value.indexOf(",", caret);
  if (end === -1) end = value.length;
  let from = start;
  while (from < end && value[from] === " ") from++;
  let to = end;
  while (to > from && value[to - 1] === " ") to--;
  if (to < from) to = from;
  return { from, to, query: value.slice(from, to) };
}

/** Other items already in a comma list (so they aren't suggested twice). */
export function otherListItems(value: string, caret: number): string[] {
  const span = listSpan(value, caret);
  return (value.slice(0, span.from) + "," + value.slice(span.to))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** An unclosed `[[` before the caret: complete the link name. */
export function wikilinkSpan(value: string, caret: number): Span | null {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf("[[");
  if (open === -1 || before.indexOf("]]", open) !== -1) return null;
  const query = before.slice(open + 2);
  // Swallow a closing ]] already sitting after the caret.
  const to = value.startsWith("]]", caret) ? caret + 2 : caret;
  return { from: open, to, query: query.replace(/[|#].*$/, ""), kind: "link" };
}

// ----------------------------------------------------------------- sources

/** Every folder path; the root is "" (shown as "(vault root)"). */
export function folderItems(app: App): SuggestItem[] {
  return app.vault
    .getAllFolders(true)
    .map((f) => (f.isRoot() ? "" : f.path))
    .sort((a, b) => a.localeCompare(b))
    .map((p) => ({ value: p }));
}

/** Files by path, optionally only certain extensions. */
export function filePathItems(app: App, extensions?: string[]): SuggestItem[] {
  const ext = extensions?.map((e) => e.toLowerCase());
  return app.vault
    .getFiles()
    .filter((f) => !ext || ext.includes(f.extension.toLowerCase()))
    .map((f) => f.path)
    .sort((a, b) => a.localeCompare(b))
    .map((p) => ({ value: p }));
}

/** Markdown notes by name; the path shows underneath when names collide. */
export function noteNameItems(app: App): SuggestItem[] {
  const files = app.vault.getMarkdownFiles();
  const count = new Map<string, number>();
  for (const f of files) count.set(f.basename, (count.get(f.basename) ?? 0) + 1);
  return files
    .sort((a, b) => a.basename.localeCompare(b.basename) || a.path.localeCompare(b.path))
    .map((f) =>
      (count.get(f.basename) ?? 0) > 1
        ? { value: f.path.replace(/\.md$/, ""), label: f.basename, detail: f.path }
        : { value: f.basename }
    );
}

/** Markdown files under a folder ("" = whole vault). */
export function markdownFilesIn(app: App, folder: string): TFile[] {
  const root = app.vault.getAbstractFileByPath(folder === "" ? "/" : folder);
  if (!(root instanceof TFolder)) return [];
  if (root.isRoot()) return app.vault.getMarkdownFiles();
  const prefix = root.path + "/";
  return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
}

function byCount(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([k]) => k);
}

/** Tags used anywhere (frontmatter + inline), most used first. */
export function tagItems(app: App, withHash: boolean): string[] {
  const counts = new Map<string, number>();
  for (const f of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(f);
    if (!cache) continue;
    for (const t of new Set(getAllTags(cache) ?? [])) {
      const bare = t.replace(/^#/, "");
      counts.set(bare, (counts.get(bare) ?? 0) + 1);
    }
  }
  return byCount(counts).map((t) => (withHash ? `#${t}` : t));
}

/** Frontmatter keys used by notes in `files` (default: whole vault), A→Z. */
export function propertyKeyItems(app: App, files?: TFile[]): string[] {
  const keys = new Set<string>();
  for (const f of files ?? app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (fm) for (const k of Object.keys(fm)) if (k !== "position") keys.add(k);
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * Values a property holds across `files` (default: whole vault): lists are
 * flattened, duplicates merged, most frequent first. `tags` values come back
 * without their `#`, the way frontmatter stores them.
 */
export function propertyValueItems(app: App, key: string, files?: TFile[]): string[] {
  const k = key.trim();
  if (!k) return [];
  const counts = new Map<string, number>();
  const isTags = k.toLowerCase() === "tags";
  for (const f of files ?? app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm) continue;
    // Frontmatter keys are case-sensitive in YAML but Obsidian treats them
    // case-insensitively; match either.
    const raw = k in fm ? fm[k] : fm[Object.keys(fm).find((x) => x.toLowerCase() === k.toLowerCase()) ?? ""];
    if (raw === undefined || raw === null) continue;
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      let text = valueToDisplay(v).trim();
      if (isTags) text = text.replace(/^#/, "");
      if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  return byCount(counts);
}

/**
 * Values to offer for `key`: what `preferFiles` (e.g. this grid's notes) use
 * first, then the rest of the vault. `tags` offers every tag in the vault,
 * inline ones included, without the `#`.
 */
export function valueItemsFor(app: App, key: string, preferFiles?: TFile[]): string[] {
  if (key.trim().toLowerCase() === "tags") return tagItems(app, false);
  const out = new Set<string>(preferFiles ? propertyValueItems(app, key, preferFiles) : []);
  for (const v of propertyValueItems(app, key)) out.add(v);
  return [...out];
}
