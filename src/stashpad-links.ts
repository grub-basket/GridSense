import { App, Notice, TFile } from "obsidian";

/**
 * Open a note in Stashpad from a GridSense grid.
 *
 * A note that lives in a Stashpad folder is a node in Stashpad's tree, not
 * really a plain markdown document — clicking it in the grid gets you the plain
 * editor, losing the parent/children context that is the point of it. With the
 * setting on, such a click routes to the Stashpad view instead.
 *
 * Hand-off, not reimplementation: we call the Stashpad plugin's own
 * `handleDeepLink` in-process when present, and fall back to its registered
 * `obsidian://stashpad` protocol URL otherwise. Nothing is imported from
 * Stashpad and nothing here breaks when it is absent — the caller checks
 * `stashpadTargetFor` first, which returns null the moment Stashpad is missing.
 *
 * The detection traps (all learned from the Bases Toolbox version of this
 * feature, verified live there):
 *  - Folder membership alone is wrong: `<folder>/_authors/*.md` sit in a
 *    Stashpad folder but carry `authorId`, not `id`, and can't be deep-linked.
 *  - So the test is the one the deep link needs anyway — under a known Stashpad
 *    folder AND frontmatter carries a Stashpad `id`. No id → nothing to link
 *    to → the normal editor opens.
 */

const STASHPAD_ID = "stashpad";

interface StashpadPlugin {
  settings?: { folder?: unknown; recentFolders?: unknown; lastUsedFolder?: unknown };
  /** Authoritative folder list, when this Stashpad build exposes it. */
  discoverStashpadFolders?: () => string[];
  handleDeepLink?: (
    params: { folder?: string; note?: string; run?: string },
    opts?: { forceNewTab?: boolean; silent?: boolean }
  ) => Promise<boolean> | boolean;
}

interface AppInternals {
  plugins?: { plugins?: Record<string, unknown>; enabledPlugins?: Set<string> };
}

function stashpad(app: App): StashpadPlugin | null {
  const p = (app as unknown as AppInternals).plugins?.plugins?.[STASHPAD_ID];
  return p ? (p as StashpadPlugin) : null;
}

/** Is the Stashpad plugin installed and enabled? (For the settings notice.) */
export function stashpadInstalled(app: App): boolean {
  return stashpad(app) !== null;
}

/** Every folder Stashpad owns, longest first so a nested folder wins over its
 *  parent. Prefers the authoritative discovery method; falls back to settings. */
function stashpadFolders(sp: StashpadPlugin): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) out.add(v.trim().replace(/\/+$/, ""));
  };
  if (typeof sp.discoverStashpadFolders === "function") {
    try {
      for (const f of sp.discoverStashpadFolders()) add(f);
    } catch {
      /* fall through to settings */
    }
  }
  if (!out.size) {
    add(sp.settings?.folder);
    add(sp.settings?.lastUsedFolder);
    const recent = sp.settings?.recentFolders;
    if (Array.isArray(recent)) for (const r of recent) add(r);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export interface StashpadTarget {
  folder: string;
  /** The note's frontmatter id — what the deep link addresses. */
  note: string;
}

/**
 * The Stashpad coordinates for a file, or null when it isn't a Stashpad note
 * (Stashpad absent, wrong folder, or no id).
 */
export function stashpadTargetFor(app: App, file: TFile): StashpadTarget | null {
  const sp = stashpad(app);
  if (!sp) return null;
  const folder = stashpadFolders(sp).find((f) => file.path.startsWith(`${f}/`));
  if (!folder) return null;
  const raw = app.metadataCache.getFileCache(file)?.frontmatter?.id;
  // Numbers are accepted because YAML turns an all-digit id into one (Stashpad's
  // own readId has the same guard).
  const note = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  return note ? { folder, note } : null;
}

/**
 * Hand off to Stashpad. `run:"reveal"`, never `"open"` — Stashpad's `open`
 * macro ALSO calls `leaf.openFile()`, i.e. opens the markdown editor, the exact
 * thing this feature avoids. Returns false only when Stashpad vanished between
 * the target check and here.
 */
export function openInStashpad(app: App, target: StashpadTarget, newTab: boolean): boolean {
  const sp = stashpad(app);
  if (!sp) return false;
  if (typeof sp.handleDeepLink === "function") {
    void sp.handleDeepLink(
      { folder: target.folder, note: target.note, run: "reveal" },
      { forceNewTab: newTab, silent: true }
    );
    return true;
  }
  // Fallback: the registered obsidian:// handler — slower (round-trips through
  // the OS) but Stashpad's supported, documented surface, so it survives an
  // internal rename that would break the in-process call above.
  const url =
    `obsidian://${STASHPAD_ID}?folder=${encodeURIComponent(target.folder)}` +
    `&note=${encodeURIComponent(target.note)}&run=reveal`;
  window.open(url);
  return true;
}

/** One-time nudge when the setting is switched on without Stashpad present. */
export function warnStashpadMissing(app: App): void {
  if (!stashpadInstalled(app))
    new Notice("GridSense: Stashpad isn't installed — note links open in the editor as usual.");
}
