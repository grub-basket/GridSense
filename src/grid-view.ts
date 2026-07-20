import {
  AbstractInputSuggest,
  App,
  ItemView,
  Menu,
  Modal,
  Notice,
  Setting,
  TFile,
  WorkspaceLeaf,
  debounce,
} from "obsidian";
import type GridSensePlugin from "./main";
import { GridStore } from "./store";
import { EditEngine, parseInput, valueToDisplay } from "./edits";
import { allHeadings } from "./headings";
import { HistoryLogModal, appendHistory, readHistory } from "./history-log";
import { CellRef, ColumnSpec } from "./types";

export const GRID_VIEW_TYPE = "gridsense-grid";

interface GridViewState {
  folder: string;
  [key: string]: unknown;
}

export class GridView extends ItemView {
  private folder = "";
  private store: GridStore | null = null;
  private engine: EditEngine;
  private cols: ColumnSpec[] = [];
  private anchor: CellRef | null = null;
  private head: CellRef | null = null;
  private editing = false;
  private tableEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private pendingEl: HTMLElement | null = null;
  private pendingWhileEditing = false;
  private requestRender = debounce(() => void this.render(), 150, true);

  constructor(leaf: WorkspaceLeaf, readonly plugin: GridSensePlugin) {
    super(leaf);
    this.engine = new EditEngine(this.app, (entry) =>
      void appendHistory(this.app, this.folder, entry)
    );
  }

  getViewType() {
    return GRID_VIEW_TYPE;
  }
  getDisplayText() {
    return this.folder ? `Grid: ${this.folder.split("/").pop()}` : "GridSense";
  }
  getIcon() {
    return "table";
  }

  getState(): GridViewState {
    return { folder: this.folder };
  }

  async setState(state: GridViewState, result: unknown): Promise<void> {
    this.folder = state?.folder ?? "";
    this.attachStore();
    await this.render();
    // @ts-expect-error obsidian's setState signature varies across versions
    return super.setState(state, result);
  }

  private attachStore() {
    this.store?.detach();
    this.store = new GridStore(
      this.app,
      this.folder,
      () => this.plugin.folderConfig(this.folder).headingColumns,
      () => {
        if (this.editing) {
          // Don't yank the cell editor away — flag it and refresh on commit.
          this.pendingWhileEditing = true;
          this.pendingEl?.show();
        } else {
          this.requestRender();
        }
      }
    );
  }

  /** Called when a cell editor closes: run the refresh we held back. */
  private flushPendingRefresh() {
    if (!this.pendingWhileEditing) return;
    this.pendingWhileEditing = false;
    this.requestRender();
  }

  async onOpen() {
    this.containerEl.addClass("gridsense-view");
    this.registerDomEvent(this.containerEl, "keydown", (e) => this.onKeyDown(e));
    this.registerDomEvent(this.containerEl, "copy", (e) => this.onCopy(e));
    this.registerDomEvent(this.containerEl, "paste", (e) => this.onPaste(e));
  }

  async onClose() {
    this.store?.detach();
  }

  // ------------------------------------------------------------------ render

  async render() {
    if (!this.store) return;
    await this.store.compile();
    const cfg = this.plugin.folderConfig(this.folder);
    this.cols = this.store.columns(cfg.hidden);
    const rows = this.store.rows;

    const content = this.contentEl;
    content.empty();
    content.addClass("gridsense-content");

    // Toolbar
    const bar = content.createDiv({ cls: "gridsense-toolbar" });
    bar.createSpan({ cls: "gridsense-scope", text: this.folder || "(vault)" });
    const mkBtn = (label: string, title: string, fn: () => void) => {
      const b = bar.createEl("button", { text: label, attr: { title } });
      b.addEventListener("click", fn);
      return b;
    };
    mkBtn("↺", "Recompile from notes", () => {
      this.store && ((this.store as unknown as { dirty: boolean }).dirty = true);
      this.attachStore();
      void this.render();
    });
    mkBtn("▦ columns", "Show/hide columns, add heading columns", () => this.openColumnsModal());
    mkBtn("＋ heading column", "Add a column showing content under a heading", () =>
      this.addHeadingColumn()
    );
    mkBtn("⇅ find & replace", "Find & replace in selection (or whole grid)", () =>
      this.openFindReplace()
    );
    mkBtn("⎌ undo", "Undo last grid edit (Cmd/Ctrl+Z)", () => void this.undo());
    mkBtn("🕘 history", "Permanent edit log for this grid (survives restarts)", async () => {
      const entries = await readHistory(this.app, this.folder);
      new HistoryLogModal(this.app, this.folder, entries).open();
    });
    this.pendingEl = bar.createSpan({
      cls: "gridsense-pending",
      text: "⟳ other files in this folder changed — grid refreshes when you finish editing",
    });
    this.pendingEl.hide();
    this.statusEl = bar.createSpan({ cls: "gridsense-status" });

    // Table
    const scroller = content.createDiv({ cls: "gridsense-scroller" });
    const table = scroller.createEl("table", { cls: "gridsense-table" });
    this.tableEl = table;
    const thead = table.createEl("thead");
    const hr = thead.createEl("tr");
    hr.createEl("th", { cls: "gridsense-rownum", text: "#" });
    this.cols.forEach((c, ci) => {
      const th = hr.createEl("th", {
        text: c.kind === "heading" ? `# ${c.key}` : c.key,
        cls: `gridsense-col-${c.kind}`,
      });
      if (c.kind === "heading") {
        th.setAttr("title", "Content under this heading (click × to remove)");
        const x = th.createSpan({ cls: "gridsense-remove-col", text: "×" });
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          this.removeHeadingColumn(c.key);
        });
      }
      if (c.kind === "prop") {
        th.addEventListener("click", () => this.selectColumn(ci));
        th.setAttr("title", "Click to select column · right-click for options");
        const x = th.createSpan({ cls: "gridsense-remove-col", text: "×" });
        x.setAttr("title", `Hide column "${c.key}" (restore via ▦ columns)`);
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.hideColumn(c.key);
        });
        th.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const menu = new Menu();
          menu.addItem((i) =>
            i.setTitle(`Hide column "${c.key}"`).setIcon("eye-off").onClick(() => void this.hideColumn(c.key))
          );
          menu.addItem((i) =>
            i.setTitle("Manage columns…").setIcon("settings-2").onClick(() => this.openColumnsModal())
          );
          menu.showAtMouseEvent(e);
        });
      }
    });

    const tbody = table.createEl("tbody");
    rows.forEach((row, ri) => {
      const tr = tbody.createEl("tr");
      tr.createEl("td", { cls: "gridsense-rownum", text: String(ri + 1) });
      this.cols.forEach((c, ci) => {
        const td = tr.createEl("td", { cls: `gridsense-cell gridsense-col-${c.kind}` });
        td.dataset.row = String(ri);
        td.dataset.col = String(ci);
        this.paintCell(td, ri, ci);
        td.addEventListener("mousedown", (e) => this.onCellMouseDown(e, ri, ci));
        td.addEventListener("mouseenter", (e) => this.onCellMouseEnter(e, ri, ci));
        td.addEventListener("dblclick", () => this.beginEdit(ri, ci));
        td.addEventListener("contextmenu", (e) => this.onCellContextMenu(e, ri, ci));
      });
    });
    this.paintSelection();
    this.updateStatus(`${rows.length} notes · ${this.cols.length - 1} columns`);
    content.tabIndex = 0;
  }

  private cellValue(ri: number, ci: number): unknown {
    const row = this.store!.rows[ri];
    const c = this.cols[ci];
    if (!row || !c) return "";
    if (c.kind === "file") return row.file.basename;
    if (c.kind === "heading") return row.headings[c.key] ?? "";
    return row.fm[c.key];
  }

  private paintCell(td: HTMLElement, ri: number, ci: number) {
    td.empty();
    const c = this.cols[ci];
    const row = this.store!.rows[ri];
    if (c.kind === "file") {
      const a = td.createEl("a", { text: row.file.basename, cls: "gridsense-filelink" });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void this.app.workspace.getLeaf(e.metaKey || e.ctrlKey ? "tab" : false).openFile(row.file);
      });
      return;
    }
    const v = this.cellValue(ri, ci);
    const text = valueToDisplay(v);
    if (c.kind === "heading") {
      const hasHeading = (this.app.metadataCache.getFileCache(row.file)?.headings ?? []).some(
        (h) => h.heading.trim().toLowerCase() === c.key.trim().toLowerCase()
      );
      if (!hasHeading) {
        td.createDiv({ cls: "gridsense-heading-preview", text });
        return;
      }
      const link = td.createEl("a", { cls: "gridsense-heading-link", text: `↳ ${c.key}` });
      link.setAttr("title", `Open ${row.file.basename} at "${c.key}"`);
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.app.workspace.openLinkText(
          `${row.file.path}#${c.key}`,
          "",
          e.metaKey || e.ctrlKey
        );
      });
      td.createDiv({ cls: "gridsense-heading-preview", text });
      return;
    }
    td.setText(text);
    if (typeof v === "boolean") td.addClass("gridsense-bool");
    if (typeof v === "number") td.addClass("gridsense-num");
  }

  // --------------------------------------------------------------- selection

  private selRange(): { r1: number; r2: number; c1: number; c2: number } | null {
    if (!this.anchor || !this.head) return null;
    return {
      r1: Math.min(this.anchor.row, this.head.row),
      r2: Math.max(this.anchor.row, this.head.row),
      c1: Math.min(this.anchor.col, this.head.col),
      c2: Math.max(this.anchor.col, this.head.col),
    };
  }

  private paintSelection() {
    if (!this.tableEl) return;
    this.tableEl.querySelectorAll(".gridsense-selected, .gridsense-active").forEach((el) => {
      el.removeClass("gridsense-selected");
      el.removeClass("gridsense-active");
    });
    const r = this.selRange();
    if (!r) return;
    for (let ri = r.r1; ri <= r.r2; ri++)
      for (let ci = r.c1; ci <= r.c2; ci++) this.cellEl(ri, ci)?.addClass("gridsense-selected");
    if (this.head) this.cellEl(this.head.row, this.head.col)?.addClass("gridsense-active");
    const n = (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);
    if (n > 1) this.updateStatus(`${n} cells selected`);
  }

  private cellEl(ri: number, ci: number): HTMLElement | null {
    return (
      this.tableEl?.querySelector(`td[data-row="${ri}"][data-col="${ci}"]`) ?? null
    ) as HTMLElement | null;
  }

  private setSel(anchor: CellRef, head?: CellRef) {
    this.anchor = anchor;
    this.head = head ?? { ...anchor };
    this.paintSelection();
    this.cellEl(this.head.row, this.head.col)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private dragging = false;

  private onCellMouseDown(e: MouseEvent, ri: number, ci: number) {
    if (this.editing) this.commitEdit();
    if ((e.target as HTMLElement).closest("a")) return;
    e.preventDefault();
    this.contentEl.focus();
    if (e.shiftKey && this.anchor) this.setSel(this.anchor, { row: ri, col: ci });
    else this.setSel({ row: ri, col: ci });
    this.dragging = true;
    const up = () => {
      this.dragging = false;
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mouseup", up);
  }

  private onCellMouseEnter(_e: MouseEvent, ri: number, ci: number) {
    if (this.dragging && this.anchor) this.setSel(this.anchor, { row: ri, col: ci });
  }

  private selectColumn(ci: number) {
    const last = this.store!.rows.length - 1;
    if (last < 0) return;
    this.setSel({ row: 0, col: ci }, { row: last, col: ci });
  }

  // ---------------------------------------------------------------- keyboard

  private onKeyDown(e: KeyboardEvent) {
    if (this.editing) return; // input handles its own keys
    const mod = e.metaKey || e.ctrlKey;
    const move = (dr: number, dc: number, extend: boolean) => {
      e.preventDefault();
      const base = extend && this.head ? this.head : this.head ?? { row: 0, col: 1 };
      const row = Math.max(0, Math.min(this.store!.rows.length - 1, base.row + dr));
      const col = Math.max(1, Math.min(this.cols.length - 1, base.col + dc));
      if (extend && this.anchor) this.setSel(this.anchor, { row, col });
      else this.setSel({ row, col });
    };
    switch (e.key) {
      case "ArrowDown":
        return move(mod ? this.store!.rows.length : 1, 0, e.shiftKey);
      case "ArrowUp":
        return move(mod ? -this.store!.rows.length : -1, 0, e.shiftKey);
      case "ArrowRight":
        return move(0, mod ? this.cols.length : 1, e.shiftKey);
      case "ArrowLeft":
        return move(0, mod ? -this.cols.length : -1, e.shiftKey);
      case "Tab":
        return move(0, e.shiftKey ? -1 : 1, false);
      case "Enter":
        if (this.head) {
          e.preventDefault();
          this.beginEdit(this.head.row, this.head.col);
        }
        return;
      case "F2":
        if (this.head) this.beginEdit(this.head.row, this.head.col);
        return;
      case "Backspace":
      case "Delete":
        e.preventDefault();
        void this.clearSelection();
        return;
      case "Escape":
        this.anchor = this.head = null;
        this.paintSelection();
        return;
    }
    if (mod && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      void this.fill("down");
      return;
    }
    if (mod && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      void this.fill("right");
      return;
    }
    if (mod && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      this.openFindReplace();
      return;
    }
    if (mod && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
      e.preventDefault();
      void this.undo();
      return;
    }
    // Type-to-edit: printable character replaces the active cell.
    if (!mod && e.key.length === 1 && this.head) {
      this.beginEdit(this.head.row, this.head.col, e.key);
      e.preventDefault();
    }
  }

  // ------------------------------------------------------------------ editing

  private beginEdit(ri: number, ci: number, seed?: string) {
    const c = this.cols[ci];
    if (!c || c.kind === "file") return;
    if (c.kind === "heading") {
      new Notice("Heading columns are read-only previews (edit the note body)");
      return;
    }
    const td = this.cellEl(ri, ci);
    if (!td) return;
    this.editing = true;
    this.setSel({ row: ri, col: ci });
    const current = valueToDisplay(this.cellValue(ri, ci));
    td.empty();
    const input = td.createEl("input", { cls: "gridsense-editor", type: "text" });
    input.value = seed !== undefined ? seed : current;
    input.focus();
    if (seed === undefined) input.select();
    const finish = (commit: boolean, thenMove?: { dr: number; dc: number }) => {
      if (!this.editing) return;
      this.editing = false;
      const text = input.value;
      this.paintCell(td, ri, ci);
      this.contentEl.focus();
      if (commit && text !== current) {
        const row = this.store!.rows[ri];
        const value = parseInput(text, row.fm[c.key]);
        row.fm[c.key] = value === null ? undefined : value; // optimistic
        this.paintCell(td, ri, ci);
        void this.engine.apply(`edit ${c.key}`, [{ file: row.file, key: c.key, value }]);
      }
      if (thenMove) {
        const row = Math.max(0, Math.min(this.store!.rows.length - 1, ri + thenMove.dr));
        const col = Math.max(1, Math.min(this.cols.length - 1, ci + thenMove.dc));
        this.setSel({ row, col });
      } else {
        this.setSel({ row: ri, col: ci });
      }
      this.flushPendingRefresh();
    };
    this.commitEdit = () => finish(true);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true, { dr: e.shiftKey ? -1 : 1, dc: 0 });
      } else if (e.key === "Tab") {
        e.preventDefault();
        finish(true, { dr: 0, dc: e.shiftKey ? -1 : 1 });
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }

  private commitEdit: () => void = () => {};

  // -------------------------------------------------------------- operations

  /** Mirror pending writes into the in-memory rows so back-to-back grid ops
   * (fill → replace, etc.) never read stale values while processFrontMatter
   * and the metadata-cache refresh are still in flight. */
  private applyLocal(writes: { file: TFile; key: string; value: unknown }[]) {
    const byPath = new Map(this.store!.rows.map((r) => [r.file.path, r]));
    for (const w of writes) {
      const row = byPath.get(w.file.path);
      if (row) {
        if (w.value === null || w.value === undefined) delete row.fm[w.key];
        else row.fm[w.key] = w.value;
      }
    }
    this.requestRender();
  }

  private writableCells(): { ri: number; ci: number }[] {
    const r = this.selRange();
    if (!r) return [];
    const out: { ri: number; ci: number }[] = [];
    for (let ri = r.r1; ri <= r.r2; ri++)
      for (let ci = r.c1; ci <= r.c2; ci++)
        if (this.cols[ci]?.kind === "prop") out.push({ ri, ci });
    return out;
  }

  private async clearSelection() {
    const cells = this.writableCells();
    if (!cells.length) return;
    const writes = cells.map(({ ri, ci }) => ({
      file: this.store!.rows[ri].file,
      key: this.cols[ci].key,
      value: null as unknown,
    }));
    this.applyLocal(writes);
    const n = await this.engine.apply("clear cells", writes);
    if (n) new Notice(`GridSense: cleared ${n} cell${n === 1 ? "" : "s"}`);
  }

  /** Fill selection from its first row (down) or first column (right). */
  private async fill(dir: "down" | "right") {
    const r = this.selRange();
    if (!r) return;
    const writes: { file: TFile; key: string; value: unknown }[] = [];
    if (dir === "down") {
      for (let ci = r.c1; ci <= r.c2; ci++) {
        if (this.cols[ci]?.kind !== "prop") continue;
        const src = this.cellValue(r.r1, ci);
        for (let ri = r.r1 + 1; ri <= r.r2; ri++)
          writes.push({ file: this.store!.rows[ri].file, key: this.cols[ci].key, value: src ?? null });
      }
    } else {
      for (let ri = r.r1; ri <= r.r2; ri++) {
        const src = this.cellValue(ri, r.c1);
        for (let ci = r.c1 + 1; ci <= r.c2; ci++) {
          if (this.cols[ci]?.kind !== "prop") continue;
          writes.push({ file: this.store!.rows[ri].file, key: this.cols[ci].key, value: src ?? null });
        }
      }
    }
    if (!writes.length) {
      new Notice("GridSense: select a range of property cells first");
      return;
    }
    this.applyLocal(writes);
    const n = await this.engine.apply(`fill ${dir}`, writes);
    new Notice(`GridSense: filled ${n} cell${n === 1 ? "" : "s"} ${dir}`);
  }

  private async undo() {
    await this.engine.undo();
  }

  // ---------------------------------------------------------- copy / paste

  private selectionTSV(): string | null {
    const r = this.selRange();
    if (!r) return null;
    const lines: string[] = [];
    for (let ri = r.r1; ri <= r.r2; ri++) {
      const cells: string[] = [];
      for (let ci = r.c1; ci <= r.c2; ci++) cells.push(valueToDisplay(this.cellValue(ri, ci)));
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }

  private onCopy(e: ClipboardEvent) {
    if (this.editing) return;
    const tsv = this.selectionTSV();
    if (tsv === null) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", tsv);
    this.updateStatus("copied");
  }

  private onPaste(e: ClipboardEvent) {
    if (this.editing || !this.head) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    this.pasteText(text);
  }

  private pasteText(text: string) {
    if (!this.head) return;
    const grid = text.replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    const start = this.selRange() ?? { r1: this.head.row, c1: this.head.col, r2: 0, c2: 0 };
    const writes: { file: TFile; key: string; value: unknown }[] = [];
    grid.forEach((line, dr) => {
      line.forEach((cell, dc) => {
        const ri = start.r1 + dr;
        const ci = start.c1 + dc;
        if (ri >= this.store!.rows.length || ci >= this.cols.length) return;
        if (this.cols[ci].kind !== "prop") return;
        const row = this.store!.rows[ri];
        writes.push({ file: row.file, key: this.cols[ci].key, value: parseInput(cell, row.fm[this.cols[ci].key]) });
      });
    });
    this.applyLocal(writes);
    void this.engine
      .apply("paste", writes)
      .then((n) => new Notice(`GridSense: pasted ${n} cell${n === 1 ? "" : "s"}`));
  }

  // ------------------------------------------------------------ context menu

  private onCellContextMenu(e: MouseEvent, ri: number, ci: number) {
    e.preventDefault();
    // Right-click outside the current selection re-targets it.
    const r = this.selRange();
    const inside = r && ri >= r.r1 && ri <= r.r2 && ci >= r.c1 && ci <= r.c2;
    if (!inside) this.setSel({ row: ri, col: ci });
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("Copy").setIcon("copy").onClick(() => {
        const tsv = this.selectionTSV();
        if (tsv !== null) void navigator.clipboard.writeText(tsv);
        this.updateStatus("copied");
      })
    );
    menu.addItem((i) =>
      i.setTitle("Paste").setIcon("clipboard-paste").onClick(async () => {
        const text = await navigator.clipboard.readText();
        if (text) this.pasteText(text);
      })
    );
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Fill down (⌘D)").setIcon("arrow-down").onClick(() => void this.fill("down")));
    menu.addItem((i) => i.setTitle("Fill right (⌘R)").setIcon("arrow-right").onClick(() => void this.fill("right")));
    menu.addItem((i) => i.setTitle("Clear cells").setIcon("eraser").onClick(() => void this.clearSelection()));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Find & replace… (⌘F)").setIcon("replace").onClick(() => this.openFindReplace()));
    const col = this.cols[ci];
    if (col?.kind === "prop")
      menu.addItem((i) =>
        i.setTitle(`Hide column "${col.key}"`).setIcon("eye-off").onClick(() => void this.hideColumn(col.key))
      );
    menu.showAtMouseEvent(e);
  }

  // ------------------------------------------------------------ find/replace

  private openFindReplace() {
    new FindReplaceModal(this).open();
  }

  /** Visible property columns first, then hidden ones (labelled by caller). */
  propColumnKeys(): string[] {
    return this.cols.filter((c) => c.kind === "prop").map((c) => c.key);
  }

  hiddenColumnKeys(): string[] {
    const visible = new Set(this.propColumnKeys());
    return (this.store?.propColumns ?? []).filter((k) => !visible.has(k));
  }

  selectedPropCells(): { ri: number; key: string }[] {
    return this.writableCells().map(({ ri, ci }) => ({ ri, key: this.cols[ci].key }));
  }

  /** Works for hidden columns too — any property key present in the scope. */
  cellsForColumn(key: string): { ri: number; key: string }[] {
    const out: { ri: number; key: string }[] = [];
    for (let ri = 0; ri < this.store!.rows.length; ri++) out.push({ ri, key });
    return out;
  }

  allPropCells(): { ri: number; key: string }[] {
    const out: { ri: number; key: string }[] = [];
    const keys = this.store?.propColumns ?? [];
    for (let ri = 0; ri < this.store!.rows.length; ri++)
      for (const key of keys) out.push({ ri, key });
    return out;
  }

  /** Used by FindReplaceModal. */
  async runReplace(
    cells: { ri: number; key: string }[],
    find: string,
    replace: string,
    matchCase: boolean
  ): Promise<number> {
    if (!find) return 0;
    const flags = matchCase ? "g" : "gi";
    const rx = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const writes: { file: TFile; key: string; value: unknown }[] = [];
    for (const { ri, key } of cells) {
      const row = this.store!.rows[ri];
      if (!row) continue;
      const cur = valueToDisplay(row.fm[key]);
      if (!rx.test(cur)) continue;
      rx.lastIndex = 0;
      const next = cur.replace(rx, replace);
      if (next === cur) continue;
      writes.push({ file: row.file, key, value: parseInput(next, row.fm[key]) });
    }
    this.applyLocal(writes);
    return this.engine.apply(`find & replace "${find}"`, writes);
  }

  // ---------------------------------------------------------------- columns

  async hideColumn(key: string) {
    const cfg = this.plugin.folderConfig(this.folder);
    if (!cfg.hidden.includes(key)) cfg.hidden.push(key);
    await this.plugin.saveSettings();
    await this.render();
    new Notice(`GridSense: hid "${key}" (▦ columns to restore)`);
  }

  async setColumnHidden(key: string, hidden: boolean) {
    const cfg = this.plugin.folderConfig(this.folder);
    cfg.hidden = cfg.hidden.filter((k) => k !== key);
    if (hidden) cfg.hidden.push(key);
    await this.plugin.saveSettings();
    await this.render();
  }

  private openColumnsModal() {
    new ColumnsModal(this).open();
  }

  /** All property keys in scope, including currently hidden ones. */
  allPropertyKeys(): string[] {
    return this.store?.propColumns ?? [];
  }

  // ----------------------------------------------------------- heading cols

  addHeadingColumn() {
    const files = this.store!.files();
    const options = allHeadings(this.app, files);
    new HeadingPickModal(this.app as never, options, async (heading) => {
      const cfg = this.plugin.folderConfig(this.folder);
      if (!cfg.headingColumns.includes(heading)) {
        cfg.headingColumns.push(heading);
        await this.plugin.saveSettings();
      }
      this.attachStore();
      await this.render();
    }).open();
  }

  async removeHeadingColumn(heading: string) {
    const cfg = this.plugin.folderConfig(this.folder);
    cfg.headingColumns = cfg.headingColumns.filter((h) => h !== heading);
    await this.plugin.saveSettings();
    this.attachStore();
    await this.render();
  }

  private updateStatus(text: string) {
    this.statusEl?.setText(text);
  }
}

// -------------------------------------------------------------------- modals

class FindReplaceModal extends Modal {
  private find = "";
  private replace = "";
  private matchCase = false;
  private searchScope = "all";

  constructor(private view: GridView) {
    super(view.app);
  }

  onOpen() {
    this.titleEl.setText("Find & replace");
    const selCells = this.view.selectedPropCells();
    if (selCells.length > 1) this.searchScope = "selection";
    const options: ScopeOption[] = [];
    if (selCells.length > 1)
      options.push({ id: "selection", label: `Selection (${selCells.length} cells)` });
    options.push({ id: "all", label: "All columns" });
    for (const key of this.view.propColumnKeys())
      options.push({ id: `col:${key}`, label: `Column: ${key}` });
    for (const key of this.view.hiddenColumnKeys())
      options.push({ id: `col:${key}`, label: `Column: ${key} (hidden)` });
    new Setting(this.contentEl)
      .setName("Scope")
      .setDesc("Which cells to search — type to filter columns")
      .addText((t) => {
        const initial = options.find((o) => o.id === this.searchScope) ?? options[0];
        t.setValue(initial.label);
        new ScopeSuggest(this.app, t.inputEl, options, (o) => {
          this.searchScope = o.id;
          t.setValue(o.label);
        });
        // Free typing: an exact column-name match (case-insensitive) counts too.
        t.onChange((v) => {
          const needle = v.trim().toLowerCase();
          const hit =
            options.find((o) => o.label.toLowerCase() === needle) ??
            options.find(
              (o) => o.id.startsWith("col:") && o.id.slice(4).toLowerCase() === needle
            );
          if (hit) this.searchScope = hit.id;
        });
      });
    new Setting(this.contentEl).setName("Find").addText((t) => {
      t.onChange((v) => (this.find = v));
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).setName("Replace with").addText((t) =>
      t.onChange((v) => (this.replace = v))
    );
    new Setting(this.contentEl)
      .setName("Match case")
      .addToggle((t) => t.setValue(false).onChange((v) => (this.matchCase = v)));
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Replace")
        .setCta()
        .onClick(async () => {
          const cells =
            this.searchScope === "selection"
              ? this.view.selectedPropCells()
              : this.searchScope.startsWith("col:")
                ? this.view.cellsForColumn(this.searchScope.slice(4))
                : this.view.allPropCells();
          const n = await this.view.runReplace(cells, this.find, this.replace, this.matchCase);
          new Notice(`GridSense: replaced in ${n} cell${n === 1 ? "" : "s"}`);
          this.close();
        })
    );
  }
}

interface ScopeOption {
  id: string;
  label: string;
}

class ScopeSuggest extends AbstractInputSuggest<ScopeOption> {
  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private options: ScopeOption[],
    private onPick: (o: ScopeOption) => void
  ) {
    super(app, inputEl);
    this.limit = 0; // uncapped — show every matching column
  }

  getSuggestions(query: string): ScopeOption[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.options;
    // Selecting an option writes its full label back into the input; showing
    // everything again on that exact text keeps the picker reopenable.
    if (this.options.some((o) => o.label.toLowerCase() === q)) return this.options;
    return this.options.filter((o) => o.label.toLowerCase().includes(q));
  }

  renderSuggestion(o: ScopeOption, el: HTMLElement): void {
    el.setText(o.label);
  }

  selectSuggestion(o: ScopeOption): void {
    this.onPick(o);
    this.inputEl.value = o.label;
    this.close();
  }
}

class ColumnsModal extends Modal {
  constructor(private view: GridView) {
    super(view.app);
  }

  onOpen() {
    this.titleEl.setText("Columns");
    this.renderBody();
  }

  private renderBody() {
    const c = this.contentEl;
    c.empty();
    const cfg = this.view.plugin.folderConfig(this.view.getState().folder as string);
    c.createEl("div", { cls: "setting-item-heading", text: "Properties" });
    for (const key of this.view.allPropertyKeys()) {
      new Setting(c).setName(key).addToggle((t) =>
        t.setValue(!cfg.hidden.includes(key)).onChange(async (v) => {
          await this.view.setColumnHidden(key, !v);
        })
      );
    }
    c.createEl("div", { cls: "setting-item-heading", text: "Heading columns" });
    if (!cfg.headingColumns.length)
      c.createDiv({ cls: "gridsense-props-empty", text: "None yet — add one below." });
    for (const h of [...cfg.headingColumns]) {
      new Setting(c)
        .setName(`# ${h}`)
        .setDesc("Content under this heading, with a link into the note")
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("Remove").onClick(async () => {
            await this.view.removeHeadingColumn(h);
            this.renderBody();
          })
        );
    }
    new Setting(c).addButton((b) =>
      b.setButtonText("Add heading column…").onClick(() => {
        this.close();
        this.view.addHeadingColumn();
      })
    );
  }
}

class HeadingPickModal extends Modal {
  constructor(
    app: never,
    private options: string[],
    private onPick: (heading: string) => void
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Add heading-content column");
    let value = "";
    new Setting(this.contentEl)
      .setName("Heading")
      .setDesc("Shows each note's content under this heading as a read-only column")
      .addText((t) => {
        t.setPlaceholder(this.options[0] ?? "Notes");
        t.onChange((v) => (value = v));
        window.setTimeout(() => t.inputEl.focus(), 0);
      });
    if (this.options.length) {
      const list = this.contentEl.createDiv({ cls: "gridsense-heading-options" });
      for (const h of this.options.slice(0, 30)) {
        const chip = list.createEl("button", { text: h, cls: "gridsense-chip" });
        chip.addEventListener("click", () => {
          this.close();
          this.onPick(h);
        });
      }
    }
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Add")
        .setCta()
        .onClick(() => {
          if (!value.trim()) return;
          this.close();
          this.onPick(value.trim());
        })
    );
  }
}
