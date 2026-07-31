import { App, TFile, TFolder, debounce, normalizePath } from "obsidian";
import { ColumnSpec, Row } from "./types";
import { extractHeadingSection } from "./headings";

const UNSAFE = new Set(["__proto__", "constructor", "prototype", "position"]);

/**
 * Compiled frontmatter database for one folder scope. Source of truth is
 * metadataCache; a JSON snapshot is persisted so the grid can paint instantly
 * on next open and so the user has a real on-disk artifact of the compilation.
 */
export class GridStore {
  rows: Row[] = [];
  propColumns: string[] = [];
  private dirty = true;
  private compiling = false;
  /** Note-order adopted once per store; later compiles only append. */
  private orderAdopted = false;
  private detachFns: (() => void)[] = [];

  /**
   * Optimistic overlay: values we just wrote, applied on top of whatever the
   * metadata cache currently says. Obsidian indexes files one at a time, so a
   * compile that lands mid-batch would otherwise repaint stale/blank cells and
   * then restore them — the flicker users see during a big fill. Entries are
   * dropped as soon as the cache agrees (or after OVERLAY_TTL as a backstop).
   */
  private overlay = new Map<string, Map<string, { value: unknown; at: number }>>();

  private static readonly OVERLAY_TTL = 15000;

  setOverlay(writes: { path: string; key: string; value: unknown }[], now: number) {
    for (const w of writes) {
      let byKey = this.overlay.get(w.path);
      if (!byKey) this.overlay.set(w.path, (byKey = new Map()));
      byKey.set(w.key, { value: w.value, at: now });
    }
  }

  private applyOverlay(row: Row, now: number) {
    const byKey = this.overlay.get(row.file.path);
    if (!byKey) return;
    for (const [key, entry] of [...byKey]) {
      const actual = row.fm[key];
      const settled =
        JSON.stringify(actual ?? null) === JSON.stringify(entry.value ?? null) ||
        (entry.value === undefined && !(key in row.fm));
      if (settled || now - entry.at > GridStore.OVERLAY_TTL) {
        byKey.delete(key);
        continue;
      }
      if (entry.value === undefined) delete row.fm[key];
      else row.fm[key] = entry.value;
    }
    if (!byKey.size) this.overlay.delete(row.file.path);
  }

  get isDirty(): boolean {
    return this.dirty;
  }
  get isEmpty(): boolean {
    return this.rows.length === 0 && this.propColumns.length === 0;
  }

  constructor(
    private app: App,
    public folderPath: string,
    private headingColumns: () => string[],
    private onInvalidate: () => void
  ) {
    const bump = debounce(
      () => {
        this.dirty = true;
        this.onInvalidate();
      },
      250,
      true
    );
    const mc = this.app.metadataCache;
    const refA = mc.on("changed", (f) => this.inScope(f.path) && bump());
    const refB = this.app.vault.on("delete", (f) => this.inScope(f.path) && bump());
    const refC = this.app.vault.on("rename", (f, old) => {
      if (this.inScope(f.path) || this.inScope(old)) bump();
    });
    const refD = this.app.vault.on("create", (f) => this.inScope(f.path) && bump());
    this.detachFns = [
      () => mc.offref(refA),
      () => this.app.vault.offref(refB),
      () => this.app.vault.offref(refC),
      () => this.app.vault.offref(refD),
    ];
  }

  detach() {
    this.detachFns.forEach((fn) => fn());
  }

  inScope(path: string): boolean {
    if (!path.endsWith(".md")) return false;
    if (this.folderPath === "/" || this.folderPath === "") return true;
    return path.startsWith(this.folderPath + "/");
  }

  files(): TFile[] {
    const root = this.app.vault.getAbstractFileByPath(
      this.folderPath === "" ? "/" : this.folderPath
    );
    const out: TFile[] = [];
    const walk = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
        else if (child instanceof TFile && child.extension === "md") out.push(child);
      }
    };
    if (root instanceof TFolder) walk(root);
    else if (this.folderPath === "/" || this.folderPath === "")
      out.push(...this.app.vault.getMarkdownFiles());
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Instant first paint: rebuild rows from the persisted JSON snapshot (the
   * on-disk database) without touching every file. Leaves the store dirty so
   * a real compile follows in the background.
   */
  async loadSnapshot(): Promise<boolean> {
    try {
      const dir = normalizePath(`${this.app.vault.configDir}/plugins/gridsense/db`);
      const slug =
        this.folderPath.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "vault";
      const p = normalizePath(`${dir}/${slug}.json`);
      if (!(await this.app.vault.adapter.exists(p))) return false;
      const payload = JSON.parse(await this.app.vault.adapter.read(p)) as {
        columns: string[];
        rows: { path: string; fm: Record<string, unknown>; headings: Record<string, string> }[];
      };
      const rows: Row[] = [];
      for (const r of payload.rows ?? []) {
        const file = this.app.vault.getAbstractFileByPath(r.path);
        if (file instanceof TFile) rows.push({ file, fm: r.fm ?? {}, headings: r.headings ?? {} });
      }
      if (!rows.length) return false;
      this.rows = rows;
      // Seeds the stable column order from the last session's snapshot.
      this.propColumns = payload.columns ?? [];
      return true;
    } catch {
      return false;
    }
  }

  async compile(): Promise<void> {
    if (!this.dirty && this.rows.length) return;
    if (this.compiling) return;
    this.compiling = true;
    try {
      await this.compileInner();
    } finally {
      this.compiling = false;
    }
  }

  private async compileInner(): Promise<void> {
    const files = this.files();
    const now = Date.now();
    const counts = new Map<string, number>();
    const rows: Row[] = [];
    for (const file of files) {
      const fm = { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) };
      for (const k of Object.keys(fm)) if (UNSAFE.has(k)) delete (fm as Record<string, unknown>)[k];
      const row: Row = { file, fm, headings: {} };
      // Overlay first, then count — a column added optimistically must exist.
      this.applyOverlay(row, now);
      for (const k of Object.keys(row.fm)) counts.set(k, (counts.get(k) ?? 0) + 1);
      rows.push(row);
    }
    // Column order follows the order properties actually appear in the notes:
    // walk the rows in order, appending each frontmatter key the first time we
    // meet it. That matches what you see when you open a note, and it's stable
    // (filling in values can't reshuffle it — an earlier version sorted by
    // usage count and columns jumped around).
    const natural: string[] = [];
    const seen = new Set<string>();
    for (const row of rows)
      for (const k of Object.keys(row.fm))
        if (!seen.has(k)) {
          seen.add(k);
          natural.push(k);
        }
    // Keys we already showed keep their slot; anything new lands where the
    // notes put it.
    const known = this.propColumns.filter((k) => counts.has(k));
    const fresh = natural.filter((k) => !known.includes(k));
    this.propColumns = [...known, ...fresh];
    // First compile of a scope (or after ↺): adopt the note order wholesale.
    if (!this.orderAdopted) {
      this.propColumns = natural;
      this.orderAdopted = true;
    }
    // Resolve heading columns (async, body reads are cached by Obsidian).
    const hcols = this.headingColumns();
    if (hcols.length) {
      await Promise.all(
        rows.map(async (r) => {
          for (const h of hcols) {
            r.headings[h] = await extractHeadingSection(this.app, r.file, h);
          }
        })
      );
    }
    this.rows = rows;
    this.dirty = false;
    void this.persistSnapshot();
  }

  columns(hidden: string[]): ColumnSpec[] {
    const cols: ColumnSpec[] = [{ kind: "file", key: "file" }];
    for (const p of this.propColumns) if (!hidden.includes(p)) cols.push({ kind: "prop", key: p });
    for (const h of this.headingColumns()) cols.push({ kind: "heading", key: h });
    return cols;
  }

  /** Persist the compiled database as a JSON file inside the plugin folder. */
  private async persistSnapshot(): Promise<void> {
    try {
      const dir = normalizePath(`${this.app.vault.configDir}/plugins/gridsense/db`);
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      const slug =
        this.folderPath.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "vault";
      const payload = {
        folder: this.folderPath,
        compiledAt: new Date().toISOString(),
        columns: this.propColumns,
        rows: this.rows.map((r) => ({ path: r.file.path, fm: r.fm, headings: r.headings })),
      };
      await adapter.write(normalizePath(`${dir}/${slug}.json`), JSON.stringify(payload, null, 1));
    } catch {
      // Snapshot is a convenience artifact; never let it break the grid.
    }
  }
}
