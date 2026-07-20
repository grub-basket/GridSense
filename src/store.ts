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
  private detachFns: (() => void)[] = [];

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

  async compile(): Promise<void> {
    if (!this.dirty && this.rows.length) return;
    const files = this.files();
    const counts = new Map<string, number>();
    const rows: Row[] = [];
    for (const file of files) {
      const fm = { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) };
      for (const k of Object.keys(fm)) {
        if (UNSAFE.has(k)) {
          delete (fm as Record<string, unknown>)[k];
          continue;
        }
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      rows.push({ file, fm, headings: {} });
    }
    this.propColumns = [...counts.keys()].sort(
      (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b)
    );
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
