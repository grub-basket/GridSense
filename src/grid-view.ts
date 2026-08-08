import {
  AbstractInputSuggest,
  App,
  FuzzySuggestModal,
  ItemView,
  Menu,
  Modal,
  Notice,
  Scope,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  debounce,
  setIcon,
} from "obsidian";
import type GridSensePlugin from "./main";
import { GridStore } from "./store";
import { EditEngine, normalizeWikiBrackets, parseInput, valueToDisplay } from "./edits";
import { allHeadings } from "./headings";
import { HistoryLogModal, appendHistory, filterHistory, readHistory } from "./history-log";
import {
  CellRef,
  ChangeRecord,
  ColumnFilter,
  ColumnSpec,
  Condition,
  FolderConfig,
  FormulaSpec,
  Row,
  colId,
} from "./types";
import { evaluateFormulas, matches } from "./formulas";
import {
  ColumnFilterPopover,
  cellValues,
  isColFilterActive,
  makeFilterButton,
  passesColFilter,
} from "./column-filter";
import { ZoomValueModal } from "./zoom";
import { AddRowModal } from "./add-row";
import { parseClipboardTable } from "./import";
import { iconForWidget, widgetForKey } from "./props-editor";
import { TOOLBOX_TOOLS, addToolboxMenu, toolboxInstalled } from "./toolbox";
import {
  ConfirmModal,
  FormulaBuilderModal,
  ListSuggest,
  RenameFileModal,
  propsInDir,
} from "./formula-builder";

export const GRID_VIEW_TYPE = "gridsense-grid";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// No cap by default: a silent cap made fresh grids look complete when they
// weren't. Virtualized rendering keeps even huge folders responsive; past
// WARN_ROWS we surface a warning instead of truncating.
const DEFAULT_LIMIT = 0;
const WARN_ROWS = 10000;
const MIN_COL_PX = 60;
const MAX_COL_PX = 340;
const ROW_BUFFER = 20;

interface GridViewState {
  folder: string;
  /** Set when the grid was opened from a .grid file. */
  file?: string;
  [key: string]: unknown;
}

export class GridView extends ItemView {
  private folder = "";
  private store: GridStore | null = null;
  private engine: EditEngine;
  private cols: ColumnSpec[] = [];
  /** Filtered + sorted + limited rows currently backing the grid. */
  private viewRows: Row[] = [];
  private truncated = 0;
  private anchor: CellRef | null = null;
  private head: CellRef | null = null;
  private editing = false;
  private tableEl: HTMLElement | null = null;
  private tbodyEl: HTMLElement | null = null;
  private scrollerEl: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private pendingEl: HTMLElement | null = null;
  private rowCountEl: HTMLElement | null = null;
  private warnEl: HTMLElement | null = null;
  private hiddenEl: HTMLElement | null = null;
  /** Excel-style order stability: once displayed, row order is frozen until
   * the user changes sort/filter/scope — edits and new rows never reshuffle. */
  private gridFile: string | null = null;
  private frozenPathOrder: string[] | null = null;
  /** Left offsets (px) for frozen columns; empty when nothing is frozen. */
  private frozenLeft: number[] = [];
  private frozenRowCount = 0;
  /**
   * Rows that were visible when the current filter was applied. Editing a cell
   * (e.g. renaming a note) must not yank its row out from under you mid-edit —
   * membership only re-decides when the filter/scope changes or you refresh.
   */
  private stickyRows: Set<string> | null = null;
  /** Rows surviving everything EXCEPT the per-column filters (dropdown source). */
  private colFilterBase: Row[] = [];
  private filterPop: ColumnFilterPopover | null = null;
  /** While a batch write runs the grid is read-only and renders are deferred. */
  private busy = false;
  private busyEl: HTMLElement | null = null;
  private viewSelectEl: HTMLSelectElement | null = null;
  /** Name of the view currently applied, for the picker's selected state. */
  private activeView = "";
  private headerH = 28;
  /** Notes created from draft rows keep their draft-side position. */
  private pinnedNew = new Map<string, "top" | "bottom">();
  /** UI-only draft rows (no file exists until committed). */
  private drafts: { top: Record<string, string>; bottom: Record<string, string> } = {
    top: {},
    bottom: {},
  };
  private draftFocusPending: "top" | "bottom" | null = null;
  private pendingWhileEditing = false;
  private rowH = 27;
  private winStart = 0;
  private winEnd = 0;
  private requestRender = debounce(() => void this.render(), 150, true);
  private saveDebounced = debounce(() => void this.plugin.saveSettings(), 800, true);

  constructor(leaf: WorkspaceLeaf, readonly plugin: GridSensePlugin) {
    super(leaf);
    this.engine = new EditEngine(this.app, (entry) =>
      void appendHistory(this.app, this.folder, entry)
    );
    // View-level keymap scope: active whenever this pane is focused. Without
    // it, Obsidian's own hotkeys win — ⌘D is editor:delete-paragraph by
    // default and swallows the event before any DOM listener runs.
    this.scope = new Scope(this.app.scope);
    const bind = (mods: string[], key: string, fn: () => void) =>
      this.scope!.register(mods as never, key, (e) => {
        if (e.defaultPrevented) return false; // DOM fallback already handled it
        if (this.editing) return true; // let the cell editor keep its keys
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return true;
        e.preventDefault();
        fn();
        return false;
      });
    bind(["Mod"], "d", () => void this.fill("down"));
    bind(["Mod"], "r", () => void this.fill("right"));
    bind(["Mod"], "f", () => this.openFindReplace());
    bind(["Mod"], "z", () => void this.undo());
    bind(["Mod", "Shift"], "z", () => void this.engine.redo());
    bind(["Mod"], "y", () => void this.engine.redo());
    bind(["Mod"], "g", () => new JumpToColumnModal(this).open());
  }

  getViewType() {
    return GRID_VIEW_TYPE;
  }
  getDisplayText() {
    if (this.gridFile) return this.gridFile.split("/").pop()?.replace(/\.grid$/, "") ?? "Grid";
    return this.folder ? `Grid: ${this.folder.split("/").pop()}` : "GridSense";
  }
  getIcon() {
    return "table";
  }

  getState(): GridViewState {
    return this.gridFile ? { folder: this.folder, file: this.gridFile } : { folder: this.folder };
  }

  async setState(state: GridViewState, result: unknown): Promise<void> {
    // A .grid file is a tiny pointer document: it names the folder to show
    // (like a .base, it's a saved view rather than a copy of the data).
    this.gridFile = typeof state?.file === "string" ? state.file : null;
    if (this.gridFile) {
      const f = this.app.vault.getAbstractFileByPath(this.gridFile);
      if (f instanceof TFile) {
        try {
          const parsed = JSON.parse(await this.app.vault.read(f)) as { folder?: string };
          state = { ...state, folder: parsed.folder ?? "" };
        } catch {
          new Notice(`GridSense: "${f.basename}.grid" isn't valid — showing the vault root`);
          state = { ...state, folder: "" };
        }
      }
    }
    this.folder = state?.folder ?? "";
    this.attachStore();
    this.buildChrome();
    // Paint instantly from the on-disk snapshot, then compile for real.
    if (this.store!.isEmpty) await this.store!.loadSnapshot();
    await this.render();
    // @ts-expect-error obsidian's setState signature varies across versions
    return super.setState(state, result);
  }

  private cfg(): FolderConfig {
    return this.plugin.folderConfig(this.folder);
  }

  private get rows(): Row[] {
    return this.viewRows;
  }

  private attachStore() {
    this.store?.detach();
    this.store = new GridStore(
      this.app,
      this.folder,
      () => this.cfg().headingColumns,
      () => {
        if (this.editing) {
          this.pendingWhileEditing = true;
          this.pendingEl?.show();
        } else {
          this.requestRender();
        }
      }
    );
  }

  /**
   * Run a batch write with the grid locked: no editing, no re-render churn,
   * and the scroll position preserved. Renders are deferred to the end so the
   * user sees one update instead of a flicker per file.
   */
  private async runBatch<T>(label: string, fn: (progress: (n: number, of: number) => void) => Promise<T>): Promise<T> {
    const scroller = this.scrollerEl;
    const keepTop = scroller?.scrollTop ?? 0;
    const keepLeft = scroller?.scrollLeft ?? 0;
    this.busy = true;
    this.containerEl.addClass("gridsense-busy");
    const notice = new Notice(`GridSense: ${label} — grid is read-only until this finishes`, 0);
    this.busyEl?.setText(`⏳ ${label}…`);
    this.busyEl?.show();
    try {
      return await fn((n, of) => {
        this.busyEl?.setText(`⏳ ${label} ${n}/${of}`);
        notice.setMessage(
          `GridSense: ${label} ${n}/${of} — grid is read-only and won't repaint until this finishes`
        );
      });
    } finally {
      this.busy = false;
      this.containerEl.removeClass("gridsense-busy");
      this.busyEl?.hide();
      notice.hide();
      await this.render();
      if (scroller) {
        scroller.scrollTop = keepTop;
        scroller.scrollLeft = keepLeft;
        this.renderWindow(true);
      }
    }
  }

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
    this.filterPop?.close();
    this.filterPop = null;
    this.store?.detach();
  }

  // ------------------------------------------------------------------ chrome

  /** Toolbar + scroller are built once per scope so the filter input keeps
   * focus across data refreshes (render() only rebuilds the table). */
  private buildChrome() {
    const content = this.contentEl;
    content.empty();
    content.addClass("gridsense-content");
    content.tabIndex = 0;

    const bar = content.createDiv({ cls: "gridsense-toolbar" });
    this.toolbarEl = bar;
    bar.createSpan({ cls: "gridsense-scope", text: this.folder || "(vault)" });
    const mkBtn = (label: string, title: string, fn: () => void) => {
      const b = bar.createEl("button", { text: label, attr: { title } });
      b.addEventListener("click", fn);
      return b;
    };
    mkBtn("↺", "Recompile from notes (also re-derives row order and filtering)", () => {
      this.resetFilterMembership();
      this.resetRowOrder();
      this.attachStore();
      void this.render();
    });
    mkBtn("▦ columns", "Views, show/hide columns, heading & formula columns", () =>
      this.openColumnsModal()
    );
    mkBtn("＋ row", "Add a row — fill the note name and its properties in one form", () =>
      this.openAddRow()
    );
    mkBtn("⇥ column", "Jump to a column (⌘/Ctrl+G)", () => new JumpToColumnModal(this).open());
    mkBtn("⛃ filters", "Stack property conditions (like Bases filters)", () =>
      new FiltersModal(this).open()
    );
    mkBtn("⇅ find & replace", "Find & replace in selection (or whole grid)", () =>
      this.openFindReplace()
    );
    mkBtn("⎌ undo", "Undo last grid action (⌘Z) — edits and column hides alike", () =>
      void this.undo()
    );
    mkBtn("↻ redo", "Redo (⇧⌘Z or ⌘Y)", () => void this.engine.redo());
    mkBtn("🕘 history", "Permanent edit log for this grid (survives restarts)", async () => {
      const entries = await readHistory(this.app, this.folder);
      new HistoryLogModal(this.app, this.folder, entries).open();
    });
    const wrapBtn = mkBtn(
      this.cfg().wrap ? "⏎ wrap: on" : "⏎ wrap: off",
      "Toggle word wrap for the whole sheet",
      () => {
        this.cfg().wrap = !this.cfg().wrap;
        wrapBtn.setText(this.cfg().wrap ? "⏎ wrap: on" : "⏎ wrap: off");
        this.saveDebounced();
        void this.render();
      }
    );
    const filterWrap = bar.createDiv({ cls: "gridsense-filter-wrap" });
    const filter = filterWrap.createEl("input", {
      cls: "gridsense-filter",
      type: "text",
      attr: { placeholder: "filter rows…" },
    });
    filter.value = this.cfg().filter ?? "";
    const clearBtn = filterWrap.createEl("button", {
      cls: "gridsense-filter-clear",
      text: "✕",
      attr: { "aria-label": "Clear filter" },
    });
    const syncClear = () => (filter.value ? clearBtn.show() : clearBtn.hide());
    syncClear();
    clearBtn.addEventListener("click", () => {
      filter.value = "";
      syncClear();
      this.cfg().filter = "";
      this.stickyRows = null;
      this.saveDebounced();
      void this.render();
      filter.focus();
    });
    const applyFilter = debounce(
      () => {
        this.cfg().filter = filter.value;
        this.stickyRows = null; // a new filter re-decides membership
        this.resetRowOrder();
        this.saveDebounced();
        this.requestRender();
      },
      200,
      true
    );
    filter.addEventListener("input", () => {
      syncClear();
      applyFilter();
    });

    this.pendingEl = bar.createSpan({
      cls: "gridsense-pending",
      text: "⟳ other files in this folder changed — grid refreshes when you finish editing",
    });
    this.pendingEl.hide();
    this.warnEl = bar.createEl("button", { cls: "gridsense-rowwarn" });
    this.warnEl.setAttr("title", "Open columns & views to hide columns or set a row limit");
    this.warnEl.addEventListener("click", () => this.openColumnsModal());
    this.warnEl.hide();
    // Saved views, switchable without opening a modal.
    this.viewSelectEl = bar.createEl("select", { cls: "gridsense-viewpick dropdown" });
    this.viewSelectEl.addEventListener("change", () => {
      const name = this.viewSelectEl?.value ?? "";
      if (name === "__save") {
        this.syncViewPicker();
        new SaveViewModal(this).open();
      } else if (name === "__manage") {
        this.syncViewPicker();
        this.openColumnsModal();
      } else if (name === "__update") {
        void this.saveView(this.activeView);
      } else if (name === "__revert") {
        void this.applyView(this.activeView);
      } else if (name) {
        void this.applyView(name);
      } else {
        this.syncViewPicker();
      }
    });
    this.syncViewPicker();

    this.busyEl = bar.createSpan({ cls: "gridsense-busy-badge" });
    this.busyEl.hide();
    this.hiddenEl = bar.createEl("button", { cls: "gridsense-hidden-warn" });
    this.hiddenEl.addEventListener("click", () => this.openColumnsModal());
    this.hiddenEl.hide();
    this.rowCountEl = bar.createSpan({ cls: "gridsense-rowcount" });
    this.statusEl = bar.createSpan({ cls: "gridsense-status" });

    this.scrollerEl = content.createDiv({ cls: "gridsense-scroller" });
    this.scrollerEl.addEventListener("scroll", () => this.onScroll());
  }

  // ------------------------------------------------------------------ render

  async render() {
    if (!this.store || !this.scrollerEl) return;
    if (this.busy) return; // deferred until the batch finishes
    // Always await the compile: the old fire-and-forget + re-render chain
    // could drop the follow-up render, leaving the grid on stale rows. The
    // snapshot preload already guarantees a fast first paint, and compiles
    // are debounced + cheap (metadata-cache reads).
    if (this.store.isEmpty || this.store.isDirty) await this.store.compile();

    const cfg = this.cfg();
    // Columns: file + visible props + formulas + headings.
    this.cols = [{ kind: "file", key: "file" }];
    for (const p of this.store.propColumns)
      if (!cfg.hidden.includes(p)) this.cols.push({ kind: "prop", key: p });
    for (const f of cfg.formulas ?? []) this.cols.push({ kind: "formula", key: f.name });
    for (const h of cfg.headingColumns) this.cols.push({ kind: "heading", key: h });
    // User-defined column order (drag headers): listed colIds first, in order;
    // anything unlisted keeps its natural position after them. File stays first.
    const order = cfg.order ?? [];
    if (order.length) {
      const rank = new Map(order.map((id, i) => [id, i]));
      const rest = this.cols.slice(1);
      rest.sort((a, b) => {
        const ra = rank.get(colId(a));
        const rb = rank.get(colId(b));
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return 0;
      });
      this.cols = [this.cols[0], ...rest];
    }

    // View pipeline: filter → sort → limit.
    let rows = this.store.rows.slice();
    // Stacked conditions run first — the toolbar's quick filter narrows what
    // they leave behind.
    const stack = cfg.filters;
    const activeConds = (stack?.conditions ?? []).filter((c) => c.prop);
    if (activeConds.length) {
      const keep = this.stickyRows;
      rows = rows.filter((r) => {
        if (keep?.has(r.file.path)) return true;
        return stack?.conjunction === "or"
          ? activeConds.some((c) => matches(r, c))
          : activeConds.every((c) => matches(r, c));
      });
    }
    const needle = (cfg.filter ?? "").trim().toLowerCase();
    const specs = cfg.formulas ?? [];
    if (specs.length) await evaluateFormulas(this.app, specs, rows);
    // Excel-style per-column filters. They run after formulas so formula and
    // heading columns are filterable too, and each column's own filter is
    // excluded when building its dropdown's value list (Excel semantics).
    this.colFilterBase = rows;
    const colFilters = this.activeColFilters();
    if (colFilters.length) {
      const keep = this.stickyRows;
      rows = rows.filter(
        (r) =>
          keep?.has(r.file.path) ||
          colFilters.every(([c, f]) => passesColFilter(cellValues(r, c), f))
      );
    }
    if (needle) {
      const keep = this.stickyRows;
      rows = rows.filter((r) => {
        // Already on screen for this filter? Stay put until the filter changes.
        if (keep?.has(r.file.path)) return true;
        if (r.file.basename.toLowerCase().includes(needle)) return true;
        for (const c of this.cols) {
          if (c.kind === "file") continue;
          const v =
            c.kind === "heading"
              ? r.headings[c.key]
              : c.kind === "formula"
                ? r.formulas?.[c.key]
                : valueToDisplay(r.fm[c.key]);
          if (v && String(v).toLowerCase().includes(needle)) return true;
        }
        return false;
      });
      this.stickyRows = new Set(rows.map((r) => r.file.path));
    } else if (activeConds.length || colFilters.length) {
      this.stickyRows = new Set(rows.map((r) => r.file.path));
    } else {
      this.stickyRows = null;
    }
    const sort = cfg.sort;
    if (sort && !this.frozenPathOrder) {
      const dir = sort.dir === "desc" ? -1 : 1;
      const val = (r: Row): unknown => {
        if (sort.key === "file") return r.file.basename;
        const col = this.cols.find((c) => c.key === sort.key);
        if (col?.kind === "heading") return r.headings[sort.key] ?? "";
        if (col?.kind === "formula") return r.formulas?.[sort.key] ?? "";
        return r.fm[sort.key];
      };
      rows.sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        const ea = va === undefined || va === null || va === "";
        const eb = vb === undefined || vb === null || vb === "";
        if (ea && eb) return 0;
        if (ea) return 1; // empties last regardless of direction
        if (eb) return -1;
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
        return String(valueToDisplay(va)).localeCompare(String(valueToDisplay(vb)), undefined, {
          numeric: true,
        }) * dir;
      });
    }
    // Freeze (or apply the frozen) display order — Excel semantics: data
    // edits never move rows; only sort/filter/scope changes re-derive order.
    if (!this.frozenPathOrder) {
      this.frozenPathOrder = rows.map((r) => r.file.path);
    } else {
      const rank = new Map(this.frozenPathOrder.map((p, i) => [p, i]));
      const top: Row[] = [];
      const mid: Row[] = [];
      const bot: Row[] = [];
      for (const r of rows) {
        if (rank.has(r.file.path)) mid.push(r);
        else if (this.pinnedNew.get(r.file.path) === "top") top.push(r);
        else bot.push(r);
      }
      mid.sort((a, b) => (rank.get(a.file.path) ?? 0) - (rank.get(b.file.path) ?? 0));
      rows = [...top, ...mid, ...bot];
    }

    // Per-folder limit wins; otherwise the plugin-wide default from settings.
    const limit = cfg.limit ?? this.plugin.settings.defaultRowLimit ?? DEFAULT_LIMIT;
    this.truncated = limit > 0 ? Math.max(0, rows.length - limit) : 0;
    this.viewRows = limit > 0 ? rows.slice(0, limit) : rows;

    this.buildTable();
    this.syncViewPicker(); // reflect drift after any config change
    this.paintSelection();
    // Prominent row count: total when everything shows, "x of y" otherwise.
    const totalAll = this.store.rows.length;
    const visible = this.viewRows.length;
    if (this.rowCountEl) {
      this.rowCountEl.setText(
        visible === totalAll
          ? `${totalAll.toLocaleString()} rows`
          : `${visible.toLocaleString()} of ${totalAll.toLocaleString()} rows`
      );
      this.rowCountEl.toggleClass("gridsense-rowcount-partial", visible !== totalAll);
      const why: string[] = [];
      if (needle) why.push("filter");
      if (colFilters.length) why.push("column filters");
      if (this.truncated) why.push(`row limit (${limit})`);
      this.rowCountEl.setAttr(
        "title",
        visible === totalAll ? "All rows visible" : `Reduced by: ${why.join(" + ")}`
      );
    }
    if (this.warnEl) {
      if (totalAll > WARN_ROWS && !(limit > 0)) {
        this.warnEl.setText(
          `⚠ ${totalAll.toLocaleString()} rows — hide columns or set a row limit`
        );
        this.warnEl.show();
      } else {
        this.warnEl.hide();
      }
    }
    // Loud, non-clashing notice that the grid isn't showing everything.
    if (this.hiddenEl) {
      const hiddenCols = cfg.hidden.filter((k) => (this.store?.propColumns ?? []).includes(k));
      const hiddenRows = totalAll - visible;
      const bits: string[] = [];
      if (hiddenCols.length)
        bits.push(`${hiddenCols.length} column${hiddenCols.length === 1 ? "" : "s"} hidden`);
      if (hiddenRows > 0)
        bits.push(`${hiddenRows.toLocaleString()} row${hiddenRows === 1 ? "" : "s"} not shown`);
      if (bits.length) {
        this.hiddenEl.setText(`⚠ ${bits.join(" · ")}`);
        this.hiddenEl.setAttr(
          "title",
          `${hiddenCols.length ? "Hidden columns: " + hiddenCols.join(", ") + ". " : ""}Click to manage columns, views and limits.`
        );
        this.hiddenEl.show();
      } else {
        this.hiddenEl.hide();
      }
    }
    const parts = [`${this.cols.length - 1} columns`];
    if (needle) parts.push("filtered");
    if (colFilters.length)
      parts.push(`${colFilters.length} column filter${colFilters.length === 1 ? "" : "s"}`);
    this.updateStatus(parts.join(" · "));
    if (!this.pendingWhileEditing) this.pendingEl?.hide();
  }

  private colWidth(c: ColumnSpec): number {
    const saved = this.cfg().widths?.[colId(c)];
    if (saved) return Math.max(MIN_COL_PX, saved);
    // Default: content length (sampled), capped so paragraphs don't take over.
    let maxLen = c.kind === "heading" ? 24 : c.key.length;
    const sample = this.viewRows.slice(0, 200);
    for (const r of sample) {
      const v =
        c.kind === "file"
          ? r.file.basename
          : c.kind === "heading"
            ? (r.headings[c.key] ?? "").split("\n")[0]
            : c.kind === "formula"
              ? (r.formulas?.[c.key] ?? "").split("\n")[0]
              : valueToDisplay(r.fm[c.key]);
      if (v && v.length > maxLen) maxLen = Math.min(v.length, 80);
    }
    const cap = this.cfg().widthCap ?? MAX_COL_PX;
    return Math.max(MIN_COL_PX, Math.min(cap, Math.round(maxLen * 7.2 + 24)));
  }

  private buildTable() {
    const scroller = this.scrollerEl!;
    const prevScroll = scroller.scrollTop;
    scroller.empty();
    const table = scroller.createEl("table", { cls: "gridsense-table" });
    if (this.cfg().wrap) table.addClass("gridsense-wrap");
    this.tableEl = table;

    const colgroup = table.createEl("colgroup");
    colgroup.createEl("col", { attr: { style: "width: 44px" } });
    for (const c of this.cols)
      colgroup.createEl("col", { attr: { style: `width: ${this.colWidth(c)}px` } });

    const thead = table.createEl("thead");
    const hr = thead.createEl("tr");
    hr.createEl("th", { cls: "gridsense-rownum gridsense-frozen-col", text: "#" });
    // Frozen columns: sticky with a left offset that accumulates the widths of
    // everything frozen before them (the row-number gutter counts as 44px).
    const freezeCols = Math.max(0, this.cfg().freezeCols ?? 0);
    const frozenLeft: number[] = [];
    let acc = 44;
    for (let i = 0; i < Math.min(freezeCols, this.cols.length); i++) {
      frozenLeft.push(acc);
      acc += this.colWidth(this.cols[i]);
    }
    this.frozenLeft = frozenLeft;
    const sort = this.cfg().sort;
    this.cols.forEach((c, ci) => {
      const shown = c.kind === "prop" ? this.cfg().rename?.[c.key] ?? c.key : c.key;
      const label =
        c.kind === "heading" ? `# ${shown}` : c.kind === "formula" ? `ƒ ${shown}` : shown;
      const th = hr.createEl("th", { cls: `gridsense-col-${c.kind}` });
      if (ci < frozenLeft.length) {
        th.addClass("gridsense-frozen-col");
        th.style.left = `${frozenLeft[ci]}px`;
      }
      if (c.kind !== "file") {
        th.draggable = true;
        th.addEventListener("dragstart", (e) => {
          e.dataTransfer?.setData("text/gridsense-col", colId(c));
        });
        th.addEventListener("dragover", (e) => e.preventDefault());
        th.addEventListener("drop", (e) => {
          e.preventDefault();
          const dragged = e.dataTransfer?.getData("text/gridsense-col");
          if (dragged && dragged !== colId(c)) void this.moveColumn(dragged, colId(c));
        });
      }
      th.createSpan({ text: label });
      if (c.kind === "prop" && shown !== c.key) th.setAttr("title", `Property: ${c.key}`);
      if (sort && sort.key === c.key)
        th.createSpan({ cls: "gridsense-sort-ind", text: sort.dir === "asc" ? " ▲" : " ▼" });
      if (this.cfg().showColumnFilters !== false) {
        const active = isColFilterActive(this.cfg().colFilters?.[colId(c)]);
        const btn = makeFilterButton(th, active);
        btn.addEventListener("mousedown", (e) => e.stopPropagation());
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openColumnFilter(c, btn);
        });
      }
      if (c.kind === "heading" || c.kind === "formula") {
        const x = th.createSpan({ cls: "gridsense-remove-col", text: "×" });
        x.setAttr("title", `Remove ${c.kind} column`);
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          if (c.kind === "heading") void this.removeHeadingColumn(c.key);
          else void this.removeFormulaColumn(c.key);
        });
      }
      if (c.kind === "prop") {
        th.setAttr(
          "title",
          `Property: ${c.key} · click to select · right-click for sort & options · drag to reorder`
        );
        const x = th.createSpan({ cls: "gridsense-remove-col", text: "×" });
        x.setAttr("title", `Hide column "${c.key}" (restore via ▦ columns)`);
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.hideColumn(c.key);
        });
        th.addEventListener("click", () => this.selectColumn(ci));
      }
      th.addEventListener("contextmenu", (e) => this.onHeaderContextMenu(e, c));
      // Drag-resize handle.
      const grip = th.createSpan({ cls: "gridsense-col-grip" });
      grip.addEventListener("mousedown", (e) => this.startColResize(e, c, ci));
    });
    // "＋" header at the far right: add a column in place, with autocomplete
    // over property names already used in this folder and across the vault.
    const addTh = hr.createEl("th", { cls: "gridsense-addcol", text: "＋" });
    addTh.setAttr("title", "Add a column (property on every note in this grid)");
    addTh.addEventListener("click", () => {
      if (addTh.querySelector("input")) return;
      addTh.empty();
      const input = addTh.createEl("input", {
        cls: "gridsense-draft-input",
        type: "text",
        attr: { placeholder: "property name…" },
      });
      new ListSuggest(this.app, input, () => this.propertyNameSuggestions());
      const done = () => {
        addTh.empty();
        addTh.setText("＋");
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && input.value.trim()) {
          const name = input.value;
          done();
          void this.addColumn(name);
        } else if (e.key === "Escape") {
          done();
        }
      });
      input.addEventListener("blur", () => {
        // Give the suggest click a beat to land before tearing down.
        window.setTimeout(() => {
          if (addTh.querySelector("input") === input && document.activeElement !== input) done();
        }, 200);
      });
      input.focus();
    });

    // Frozen rows live in the header so virtualization can never unmount them.
    const freezeRows = Math.max(0, this.cfg().freezeRows ?? 0);
    this.frozenRowCount = Math.min(freezeRows, this.viewRows.length);
    for (let ri = 0; ri < this.frozenRowCount; ri++) {
      const tr = this.renderRow(thead, ri);
      tr.addClass("gridsense-frozen-row");
      // sticky offsets belong on the CELLS (a <tr> can't be a sticky box);
      // stack each frozen row below the header and the ones above it.
      const top = this.headerH + ri * this.rowH;
      tr.querySelectorAll("td").forEach((td) => ((td as HTMLElement).style.top = `${top}px`));
    }

    this.tbodyEl = table.createEl("tbody");
    this.winStart = -1;
    this.winEnd = -1;
    this.renderWindow(true);
    this.buildFooter(table);
    // Re-stack frozen rows from their ACTUAL heights — estimated offsets left
    // hairline gaps that let scrolled content show through.
    const summaryEl = table.querySelector("tfoot tr.gridsense-summary") as HTMLElement | null;
    if (summaryEl && summaryEl.offsetHeight > 4)
      table.style.setProperty("--gridsense-summary-h", `${summaryEl.offsetHeight - 1}px`);
    const headerRowEl = thead.querySelector("tr") as HTMLElement | null;
    if (headerRowEl && headerRowEl.offsetHeight > 8) {
      this.headerH = headerRowEl.offsetHeight;
      let top = this.headerH;
      thead.querySelectorAll("tr.gridsense-frozen-row").forEach((tr) => {
        const el = tr as HTMLElement;
        tr.querySelectorAll("td").forEach((td) => ((td as HTMLElement).style.top = `${top}px`));
        top += el.offsetHeight || this.rowH;
      });
    }
    scroller.scrollTop = prevScroll;
    if (this.draftFocusPending) {
      const which = this.draftFocusPending;
      this.draftFocusPending = null;
      (
        table.querySelector(
          `.gridsense-draft-${which} input[data-draft-key="file"]`
        ) as HTMLInputElement | null
      )?.focus();
    }
  }

  /**
   * Empty draft row (top of thead / bottom of tfoot). UI-only: no note exists
   * until it has a name and Enter commits it — typed values live in memory,
   * so abandoning or clearing a draft can never lose file data.
   */
  private buildDraftRow(which: "top" | "bottom", parent: HTMLElement) {
    const state = this.drafts[which];
    const tr = parent.createEl("tr", { cls: `gridsense-draft gridsense-draft-${which}` });
    tr.createEl("td", { cls: "gridsense-rownum", text: "＋" });
    for (const c of this.cols) {
      const td = tr.createEl("td", { cls: "gridsense-draft-cell" });
      if (c.kind === "heading" || c.kind === "formula") continue;
      const key = c.kind === "file" ? "file" : c.key;
      const input = td.createEl("input", {
        cls: "gridsense-draft-input",
        type: "text",
        attr: {
          "data-draft-key": key,
          placeholder: c.kind === "file" ? "new note name…" : c.key,
        },
      });
      input.value = state[key] ?? "";
      input.addEventListener("input", () => {
        state[key] = input.value;
      });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          void this.commitDraft(which);
        }
      });
    }
    // Hold refreshes while typing in the draft; release when focus leaves the
    // whole row (so Tab between draft cells doesn't rebuild the table).
    tr.addEventListener("focusin", () => {
      this.editing = true;
    });
    tr.addEventListener("focusout", (e) => {
      if (!tr.contains(e.relatedTarget as Node | null)) {
        this.editing = false;
        this.flushPendingRefresh();
      }
    });
  }

  private async commitDraft(which: "top" | "bottom") {
    const state = this.drafts[which];
    const { file, ...values } = { ...state, file: state["file"] ?? "" };
    const created = await this.createRow(file, values, which);
    if (!created) return;
    this.drafts[which] = {};
    this.editing = false;
    this.draftFocusPending = which;
    this.requestRender();
  }

  /**
   * Create one note from a name + property values. Shared by the inline draft
   * row and the Add row modal, so both get the same collision checks and the
   * same SINGLE undo entry: ⌘Z moves the new note to the GridSense trash rather
   * than leaving a half-undone note with its values stripped.
   */
  async createRow(
    rawName: string,
    values: Record<string, string>,
    which: "top" | "bottom" = "bottom"
  ): Promise<TFile | null> {
    const name = (rawName ?? "").trim().replace(/[\\/:]+/g, "-");
    if (!name) {
      new Notice("GridSense: give the row a note name to create it");
      return null;
    }
    const folder = this.scopeFolder();
    const path = `${folder ? folder + "/" : ""}${name}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice("GridSense: a note with that name already exists here");
      return null;
    }
    let file: TFile;
    try {
      file = await this.app.vault.create(path, "---\n---\n");
    } catch (err) {
      new Notice(`GridSense: could not create note: ${String(err)}`);
      return null;
    }
    // Written directly rather than through the edit engine: the creation is the
    // undoable unit, so the values must not land as a second stack entry.
    const changes: ChangeRecord[] = [];
    const entries = Object.entries(values).filter(([k, v]) => k !== "file" && (v ?? "").trim());
    if (entries.length) {
      try {
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          for (const [key, text] of entries) {
            const parsed = parseInput(text, undefined);
            fm[key] = parsed;
            changes.push({ path: file.path, key, before: undefined, after: parsed });
          }
        });
      } catch (err) {
        new Notice(`GridSense: created "${name}" but could not write its properties: ${String(err)}`);
      }
    }
    void appendHistory(this.app, this.folder, {
      label: `add row "${name}"`,
      when: Date.now(),
      changes,
    });
    this.pinnedNew.set(path, which);
    const created = file;
    // Undo/redo hand the note between the grid and the GridSense trash. The
    // trashed path is remembered rather than re-derived: the trash renames on
    // collision ("name (2).md"), so a basename search could redo the wrong note
    // — or none at all.
    let trashedPath: string | null = null;
    this.engine.pushUi(
      `add row "${name}"`,
      async () => {
        const live = this.app.vault.getAbstractFileByPath(created.path);
        if (!(live instanceof TFile)) return;
        const res = await this.plugin.trash?.trash(live);
        if (!res) {
          new Notice(`GridSense: could not undo "${name}" — the note is still in the grid`);
          return;
        }
        trashedPath = res.to;
        this.pinnedNew.delete(path);
        this.requestRender();
      },
      async () => {
        const back = trashedPath ? this.app.vault.getAbstractFileByPath(trashedPath) : null;
        if (!(back instanceof TFile)) {
          new Notice(`GridSense: "${name}" is no longer in the trash — can't redo`);
          return;
        }
        await this.app.vault.rename(back, path);
        trashedPath = null;
        this.pinnedNew.set(path, which);
        this.requestRender();
      }
    );
    new Notice(`GridSense: created "${name}" — ⌘Z to undo`);
    this.requestRender();
    return file;
  }

  /** Values of the currently selected row, for seeding the Add row modal. */
  private selectedRowValues(): Record<string, string> | undefined {
    const idx = this.head?.row;
    if (idx === undefined) return undefined;
    const row = this.viewRows[idx];
    if (!row) return undefined;
    const out: Record<string, string> = {};
    for (const c of this.cols)
      if (c.kind === "prop") {
        const v = valueToDisplay(row.fm[c.key]);
        if (v) out[c.key] = v;
      }
    return out;
  }

  /** Property columns currently shown, as key + display name. Used by Add row. */
  propColumnFields(): { key: string; label: string }[] {
    return this.cols
      .filter((c) => c.kind === "prop")
      .map((c) => ({ key: c.key, label: this.cfg().rename?.[c.key] ?? c.key }));
  }

  /** Distinct values already used in a property, for value autocomplete. */
  distinctValues(key: string): string[] {
    const seen = new Set<string>();
    for (const r of this.store?.rows ?? []) {
      const raw = r.fm[key];
      if (raw === undefined || raw === null) continue;
      for (const v of Array.isArray(raw) ? raw : [raw]) {
        const text = valueToDisplay(v).trim();
        if (text) seen.add(text);
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  /** Open the Add row form. Seeded from the selected row when there is one. */
  openAddRow(seedFromSelection = false) {
    new AddRowModal(this, seedFromSelection ? this.selectedRowValues() : undefined).open();
  }

  /** Sticky footer: the bottom draft row plus Σ/avg per column. */
  private buildFooter(table: HTMLElement) {
    const tfoot = table.createEl("tfoot");
    this.buildDraftRow("bottom", tfoot);
    const sumTr = tfoot.createEl("tr", { cls: "gridsense-summary" });
    sumTr.createEl("td", { cls: "gridsense-rownum", text: "Σ" });
    for (const c of this.cols) {
      const td = sumTr.createEl("td");
      if (c.kind === "file") {
        td.setText(`${this.viewRows.length}`);
        td.setAttr("title", "Row count");
        continue;
      }
      let filled = 0;
      let numeric = 0;
      let sum = 0;
      for (const r of this.viewRows) {
        const v =
          c.kind === "heading"
            ? r.headings[c.key]
            : c.kind === "formula"
              ? r.formulas?.[c.key]
              : r.fm[c.key];
        if (v === undefined || v === null || v === "") continue;
        filled++;
        if (typeof v === "number") {
          numeric++;
          sum += v;
        }
      }
      if (numeric > 0 && numeric >= filled / 2) {
        const avg = sum / numeric;
        td.setText(`Σ ${round2(sum)} · ø ${round2(avg)}`);
        td.setAttr("title", `Sum and average of ${numeric} numbers`);
      } else if (filled) {
        td.setText(`${filled} filled`);
      }
    }
  }

  private onScroll() {
    // Direct call, not requestAnimationFrame: rAF freezes in unfocused
    // windows (popouts/background panes) and the window diff is cheap.
    if (!this.tbodyEl) return;
    this.renderWindow(false);
  }

  /** Virtualized body: only rows near the viewport exist in the DOM; spacer
   * rows keep the scrollbar honest. */
  private renderWindow(force: boolean) {
    const scroller = this.scrollerEl;
    const tbody = this.tbodyEl;
    if (!scroller || !tbody) return;
    const total = this.viewRows.length;
    const viewH = scroller.clientHeight || 600;
    const windowSize = Math.ceil(viewH / this.rowH) + ROW_BUFFER * 2;
    let start = Math.max(0, Math.floor(scroller.scrollTop / this.rowH) - ROW_BUFFER);
    start = Math.min(start, Math.max(0, total - windowSize + ROW_BUFFER));
    const end = Math.min(total, start + windowSize);
    if (!force && start === this.winStart && end === this.winEnd) return;
    this.winStart = start;
    this.winEnd = end;
    tbody.empty();
    // Top draft row: part of the scrolling flow (before the spacer), styled
    // identically to the bottom one — never sticky, never overlapping row 1.
    this.buildDraftRow("top", tbody);
    const spTop = tbody.createEl("tr", { cls: "gridsense-spacer" });
    spTop.createEl("td", {
      attr: { colspan: String(this.cols.length + 1), style: `height: ${start * this.rowH}px` },
    });
    for (let ri = Math.max(start, this.frozenRowCount); ri < end; ri++) this.renderRow(tbody, ri);
    const spBot = tbody.createEl("tr", { cls: "gridsense-spacer" });
    spBot.createEl("td", {
      attr: {
        colspan: String(this.cols.length + 1),
        style: `height: ${Math.max(0, total - end) * this.rowH}px`,
      },
    });
    // Breathing room so the sticky footer (draft row + Σ) can never cover the
    // last data row when you scroll to the bottom.
    const tail = tbody.createEl("tr", { cls: "gridsense-spacer gridsense-tailpad" });
    tail.createEl("td", { attr: { colspan: String(this.cols.length + 1) } });
    // Refine the row-height estimate from what's actually on screen.
    const rendered = end - start;
    if (rendered > 0) {
      const firstRow = tbody.querySelector("tr:not(.gridsense-spacer)") as HTMLElement | null;
      if (firstRow && firstRow.offsetHeight > 8) {
        const measured = firstRow.offsetHeight;
        if (Math.abs(measured - this.rowH) > 2) {
          this.rowH = measured;
          this.renderWindow(true);
          return;
        }
      }
    }
    this.paintSelection();
  }

  private renderRow(tbody: HTMLElement, ri: number): HTMLElement {
    const row = this.viewRows[ri];
    const tr = tbody.createEl("tr");
    const num = tr.createEl("td", { cls: "gridsense-rownum", text: String(ri + 1) });
    num.setAttr("title", "Right-click: duplicate / rename note");
    num.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((i) =>
        i.setTitle(`Duplicate "${row.file.basename}"`).setIcon("copy-plus").onClick(() =>
          void this.duplicateNote(row.file)
        )
      );
      menu.addItem((i) =>
        i.setTitle("Rename note…").setIcon("pencil").onClick(() =>
          new RenameFileModal(this.app, row.file).open()
        )
      );
      menu.addItem((i) =>
        i.setTitle("Row history…").setIcon("history").onClick(() =>
          void this.openScopedHistory({ path: row.file.path, label: `row: ${row.file.basename}` })
        )
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Delete note…")
          .setIcon("trash")
          .onClick(() =>
            new ConfirmModal(
              this.app,
              `Delete "${row.file.basename}"?`,
              `The note moves to "${this.plugin.trash?.folderPath()}" inside your vault, so ⌘Z brings it straight back. Empty that folder into Obsidian's trash with the "Empty GridSense trash" command.`,
              "Move to GridSense trash",
              async () => {
                const res = await this.plugin.trash?.trash(row.file);
                if (!res) return;
                this.engine.pushUi(
                  `delete note "${row.file.basename}"`,
                  () => res.restore(),
                  async () => {
                    const back = this.app.vault.getAbstractFileByPath(res.from);
                    if (back instanceof TFile) await this.plugin.trash?.trash(back);
                  }
                );
                new Notice(`GridSense: "${row.file.basename}" moved to GridSense trash — ⌘Z to undo`);
              }
            ).open()
          )
      );
      menu.showAtMouseEvent(e);
    });
    this.cols.forEach((c, ci) => {
      const td = tr.createEl("td", { cls: `gridsense-cell gridsense-col-${c.kind}` });
      if (ci < this.frozenLeft.length) {
        td.addClass("gridsense-frozen-col");
        td.style.left = `${this.frozenLeft[ci]}px`;
      }
      td.dataset.row = String(ri);
      td.dataset.col = String(ci);
      this.paintCell(td, ri, ci);
      td.addEventListener("mousedown", (e) => this.onCellMouseDown(e, ri, ci));
      td.addEventListener("mouseenter", (e) => this.onCellMouseEnter(e, ri, ci));
      td.addEventListener("dblclick", () => this.beginEdit(ri, ci));
      td.addEventListener("contextmenu", (e) => this.onCellContextMenu(e, ri, ci));
    });
    return tr;
  }

  private cellValue(ri: number, ci: number): unknown {
    const row = this.rows[ri];
    const c = this.cols[ci];
    if (!row || !c) return "";
    if (c.kind === "file") return row.file.basename;
    if (c.kind === "heading") return row.headings[c.key] ?? "";
    if (c.kind === "formula") return row.formulas?.[c.key] ?? "";
    return row.fm[c.key];
  }

  private paintCell(td: HTMLElement, ri: number, ci: number) {
    td.empty();
    const c = this.cols[ci];
    const row = this.rows[ri];
    if (!c || !row) return;
    if (c.kind === "file") {
      const a = td.createEl("a", { text: row.file.basename, cls: "gridsense-filelink" });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void this.app.workspace.getLeaf(e.metaKey || e.ctrlKey ? "tab" : false).openFile(row.file);
      });
      a.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem((i) =>
          i.setTitle("Rename note…").setIcon("pencil").onClick(() =>
            new RenameFileModal(this.app, row.file).open()
          )
        );
        menu.addItem((i) =>
          i.setTitle(`Duplicate "${row.file.basename}"`).setIcon("copy-plus").onClick(() =>
            void this.duplicateNote(row.file)
          )
        );
        menu.showAtMouseEvent(e);
      });
      return;
    }
    const v = this.cellValue(ri, ci);
    const text = valueToDisplay(v);
    if (c.kind === "heading") {
      const hasHeading = (this.app.metadataCache.getFileCache(row.file)?.headings ?? []).some(
        (h) => h.heading.trim().toLowerCase() === c.key.trim().toLowerCase()
      );
      if (hasHeading) {
        const link = td.createEl("a", {
          cls: "gridsense-heading-link",
          text: this.plugin.settings.showHeadingNames ? c.key : "↳",
        });
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
      }
      td.createDiv({ cls: "gridsense-heading-preview", text });
      return;
    }
    if (c.kind === "formula") {
      td.createDiv({ cls: "gridsense-heading-preview", text });
      return;
    }
    if (/\[\[[^\]]+\]\]/.test(text)) {
      this.paintWikilinks(td, text, row.file.path);
      return;
    }
    td.setText(text);
    if (typeof v === "boolean") td.addClass("gridsense-bool");
    if (typeof v === "number") td.addClass("gridsense-num");
  }

  /**
   * Render `[[Note]]` / `[[Note|alias]]` / `[[Note#Heading]]` inside a cell as
   * real clickable links (alias shown when present), leaving other text alone.
   */
  private paintWikilinks(td: HTMLElement, text: string, sourcePath: string) {
    const rx = /\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      if (m.index > last) td.appendText(text.slice(last, m.index));
      const [, target, heading, alias] = m;
      const linkPath = `${target}${heading ?? ""}`;
      const a = td.createEl("a", {
        cls: "internal-link gridsense-wikilink",
        text: alias ?? target,
      });
      a.setAttr("title", linkPath);
      // getFirstLinkpathDest wants the link path without a heading/block ref.
      const resolved = this.app.metadataCache.getFirstLinkpathDest(
        target.trim().replace(/\.md$/i, ""),
        sourcePath
      );
      if (resolved) a.setAttr("data-href", resolved.path);
      else a.addClass("is-unresolved");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.app.workspace.openLinkText(linkPath, sourcePath, e.metaKey || e.ctrlKey);
      });
      last = m.index + m[0].length;
    }
    if (last < text.length) td.appendText(text.slice(last));
  }

  // ------------------------------------------------------------ column sizing

  private startColResize(e: MouseEvent, c: ColumnSpec, ci: number) {
    e.preventDefault();
    e.stopPropagation();
    const colEl = this.tableEl?.querySelectorAll("col")[ci + 1] as HTMLElement | undefined;
    if (!colEl) return;
    const startX = e.clientX;
    const startW = parseInt(colEl.style.width) || this.colWidth(c);
    const move = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL_PX, startW + (ev.clientX - startX));
      colEl.style.width = `${w}px`;
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const w = Math.max(MIN_COL_PX, startW + (ev.clientX - startX));
      const cfg = this.cfg();
      cfg.widths = cfg.widths ?? {};
      cfg.widths[colId(c)] = w;
      this.saveDebounced();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // ------------------------------------------------------------------- sort

  private onHeaderContextMenu(e: MouseEvent, c: ColumnSpec) {
    e.preventDefault();
    const menu = new Menu();
    const setSort = (dir: "asc" | "desc" | null) => {
      this.cfg().sort = dir ? { key: c.key, dir } : null;
      this.resetRowOrder();
      this.saveDebounced();
      void this.render();
    };
    menu.addItem((i) =>
      i
        .setTitle("Filter this column…")
        .setIcon("filter")
        .onClick(() => {
          const th = (e.currentTarget as HTMLElement) ?? (e.target as HTMLElement);
          this.openColumnFilter(c, th.closest("th") ?? th);
        })
    );
    if (this.cfg().colFilters)
      menu.addItem((i) =>
        i
          .setTitle("Clear all column filters")
          .setIcon("filter-x")
          .onClick(() => void this.clearColumnFilters())
      );
    menu.addItem((i) => i.setTitle("Sort A → Z").setIcon("arrow-down-a-z").onClick(() => setSort("asc")));
    menu.addItem((i) => i.setTitle("Sort Z → A").setIcon("arrow-up-a-z").onClick(() => setSort("desc")));
    if (this.cfg().sort)
      menu.addItem((i) => i.setTitle("Clear sort").setIcon("x").onClick(() => setSort(null)));
    if (c.kind === "prop") {
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle(`Hide column "${c.key}"`).setIcon("eye-off").onClick(() => void this.hideColumn(c.key))
      );
      menu.addItem((i) =>
        i.setTitle("Rename display name…").setIcon("pencil").onClick(() => {
          new RenameColumnModal(this, c.key).open();
        })
      );
      menu.addItem((i) =>
        i.setTitle("Column history…").setIcon("history").onClick(() =>
          void this.openScopedHistory({ key: c.key, label: `column: ${c.key}` })
        )
      );
      menu.addItem((i) =>
        i.setTitle(`Delete column "${c.key}"…`).setIcon("trash").onClick(() =>
          this.confirmDeleteColumn(c.key)
        )
      );
    }
    menu.addItem((i) =>
      i.setTitle("Set column width…").setIcon("move-horizontal").onClick(() => {
        new ColumnWidthModal(this, c).open();
      })
    );
    addToolboxMenu(this.app, menu, { perColumn: true });
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Add column…").setIcon("plus").onClick(() => new NewColumnModal(this).open())
    );
    menu.addItem((i) =>
      i.setTitle("Manage columns…").setIcon("settings-2").onClick(() => this.openColumnsModal())
    );
    menu.showAtMouseEvent(e);
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
    for (let ri = Math.max(r.r1, this.winStart); ri <= Math.min(r.r2, this.winEnd); ri++)
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
    // Only scroll when the head cell truly isn't rendered — recentering on
    // near-edge rows rebuilt the DOM mid-click and broke editing there.
    const hr = this.head.row;
    if (this.scrollerEl && !this.cellEl(hr, this.head.col)) {
      const target = Math.max(0, hr * this.rowH - this.scrollerEl.clientHeight / 2);
      this.scrollerEl.scrollTop = target;
      this.renderWindow(true);
    }
    this.paintSelection();
    this.cellEl(this.head.row, this.head.col)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private dragging = false;

  private onCellMouseDown(e: MouseEvent, ri: number, ci: number) {
    const target = e.target as HTMLElement;
    // Clicking inside the open cell editor (e.g. to place the caret or drop a
    // text selection) must not commit and close it.
    if (target.closest(".gridsense-editor")) return;
    // Right/middle mousedown must not collapse the selection — the context
    // menu needs the range that was there when you right-clicked.
    if (e.button !== 0) return;
    if (this.editing) this.commitEdit();
    if (target.closest("a")) return;
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

  private onCellMouseEnter(e: MouseEvent, ri: number, ci: number) {
    if (!this.dragging) return;
    // The primary button must still be held — a mouseup that landed outside
    // the window (or over a menu) otherwise leaves a phantom drag that keeps
    // highlighting cells as the cursor moves.
    if (!(e.buttons & 1)) {
      this.dragging = false;
      return;
    }
    if (this.anchor) this.setSel(this.anchor, { row: ri, col: ci });
  }

  private selectColumn(ci: number) {
    const last = this.rows.length - 1;
    if (last < 0) return;
    // Focus the grid so ⌘D/⌘R etc. work immediately after a header click.
    this.contentEl.focus();
    this.setSel({ row: 0, col: ci }, { row: last, col: ci });
  }

  // ---------------------------------------------------------------- keyboard

  private onKeyDown(e: KeyboardEvent) {
    if (this.editing) return; // cell editor handles its own keys
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return; // toolbar filter
    const mod = e.metaKey || e.ctrlKey;
    const move = (dr: number, dc: number, extend: boolean) => {
      e.preventDefault();
      const base = extend && this.head ? this.head : this.head ?? { row: 0, col: 1 };
      const row = Math.max(0, Math.min(this.rows.length - 1, base.row + dr));
      const col = Math.max(1, Math.min(this.cols.length - 1, base.col + dc));
      if (extend && this.anchor) this.setSel(this.anchor, { row, col });
      else this.setSel({ row, col });
    };
    switch (e.key) {
      case "ArrowDown":
        return move(mod ? this.rows.length : 1, 0, e.shiftKey);
      case "ArrowUp":
        return move(mod ? -this.rows.length : -1, 0, e.shiftKey);
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
    // Mod-key shortcuts are primarily handled by the view's keymap Scope
    // (beats Obsidian's own hotkeys in the main window). This DOM fallback
    // covers popout windows, where the scope isn't reliably active; the
    // stopPropagation keeps Obsidian's window-level keymap (and a double
    // scope run — it skips defaultPrevented events) out of the way.
    if (mod) {
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (k === "d") return run(() => void this.fill("down"));
      if (k === "r") return run(() => void this.fill("right"));
      if (k === "f") return run(() => this.openFindReplace());
      if (k === "z" && !e.shiftKey) return run(() => void this.undo());
      if (k === "z" && e.shiftKey) return run(() => void this.engine.redo());
      if (k === "y") return run(() => void this.engine.redo());
      // Mod+Shift+L (Excel's autofilter toggle). The Scope registration below
      // does NOT fire for Shift+letter combos in practice, so this DOM path is
      // the real handler, not just a popout fallback — verified live.
      if (k === "l" && e.shiftKey) return run(() => void this.toggleColumnFilters());
    }
    if (!mod && e.key.length === 1 && this.head) {
      this.beginEdit(this.head.row, this.head.col, e.key);
      e.preventDefault();
    }
  }

  // ------------------------------------------------------------------ editing

  private beginEdit(ri: number, ci: number, seed?: string) {
    if (this.busy) {
      new Notice("GridSense: hold on — a batch update is still running");
      return;
    }
    const c = this.cols[ci];
    if (!c || c.kind === "file") return;
    if (c.kind === "heading" || c.kind === "formula") {
      new Notice(
        c.kind === "heading"
          ? "Heading columns are read-only previews (edit the note body)"
          : "Formula columns are computed (edit via ▦ columns)"
      );
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
    // Wikilink autocomplete: suggests note names once you type "[[".
    new ListSuggest(this.app, input, () => {
      const m = /\[\[([^\]]*)$/.exec(input.value);
      if (!m) return [];
      const typed = m[1].toLowerCase();
      return this.app.vault
        .getMarkdownFiles()
        .map((f) => f.basename)
        .filter((n) => !typed || n.toLowerCase().includes(typed))
        .sort()
        .slice(0, 50)
        .map((n) => normalizeWikiBrackets(input.value.replace(/\[\[[^\]]*$/, `[[${n}]]`)));
    });
    // Live guard while typing: [[[ → [[ as you go.
    input.addEventListener("input", () => {
      const fixed = normalizeWikiBrackets(input.value);
      if (fixed !== input.value) {
        const drop = input.value.length - fixed.length;
        const caret = (input.selectionStart ?? fixed.length) - drop;
        input.value = fixed;
        input.setSelectionRange(Math.max(0, caret), Math.max(0, caret));
      }
    });
    input.focus();
    if (seed === undefined) input.select();
    const finish = (commit: boolean, thenMove?: { dr: number; dc: number }) => {
      if (!this.editing) return;
      this.editing = false;
      const text = input.value;
      this.paintCell(td, ri, ci);
      this.contentEl.focus();
      if (commit && normalizeWikiBrackets(text) !== current) {
        const row = this.rows[ri];
        const value = parseInput(normalizeWikiBrackets(text), row.fm[c.key]);
        row.fm[c.key] = value === null ? undefined : value; // optimistic
        this.paintCell(td, ri, ci);
        void this.engine.apply(`edit ${c.key}`, [{ file: row.file, key: c.key, value }]);
      }
      if (thenMove) {
        const row = Math.max(0, Math.min(this.rows.length - 1, ri + thenMove.dr));
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

  private applyLocal(writes: { file: TFile; key: string; value: unknown }[]) {
    const byPath = new Map(this.store!.rows.map((r) => [r.file.path, r]));
    for (const w of writes) {
      const row = byPath.get(w.file.path);
      if (row) {
        // Mirror EditEngine semantics: undefined deletes the key, null keeps
        // the property with an empty value.
        if (w.value === undefined) delete row.fm[w.key];
        else row.fm[w.key] = w.value;
      }
    }
    // Hand the same values to the store as an optimistic overlay so a compile
    // landing mid-write can't repaint stale cells (the fill-down flicker).
    this.store!.setOverlay(
      writes.map((w) => ({ path: w.file.path, key: w.key, value: w.value })),
      Date.now()
    );
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
      file: this.rows[ri].file,
      key: this.cols[ci].key,
      value: null as unknown,
    }));
    this.applyLocal(writes);
    const n = await this.engine.apply("clear cells", writes);
    if (n) new Notice(`GridSense: cleared ${n} cell${n === 1 ? "" : "s"}`);
  }

  private async fill(dir: "down" | "right") {
    const r = this.selRange();
    if (!r) {
      new Notice("GridSense: nothing selected — click a cell first");
      return;
    }
    if (dir === "down" && r.r1 === r.r2) {
      new Notice(
        "GridSense: ⌘D needs a vertical range — the top row's values fill downward (any rectangle works, not just whole columns)"
      );
      return;
    }
    if (dir === "right" && r.c1 === r.c2) {
      new Notice(
        "GridSense: ⌘R needs a horizontal range — the left column's values fill rightward"
      );
      return;
    }
    const writes: { file: TFile; key: string; value: unknown }[] = [];
    if (dir === "down") {
      for (let ci = r.c1; ci <= r.c2; ci++) {
        if (this.cols[ci]?.kind !== "prop") continue;
        const src = this.cellValue(r.r1, ci);
        for (let ri = r.r1 + 1; ri <= r.r2; ri++)
          writes.push({ file: this.rows[ri].file, key: this.cols[ci].key, value: src ?? null });
      }
    } else {
      for (let ri = r.r1; ri <= r.r2; ri++) {
        const src = this.cellValue(ri, r.c1);
        for (let ci = r.c1 + 1; ci <= r.c2; ci++) {
          if (this.cols[ci]?.kind !== "prop") continue;
          writes.push({ file: this.rows[ri].file, key: this.cols[ci].key, value: src ?? null });
        }
      }
    }
    if (!writes.length) {
      new Notice("GridSense: select a range of property cells first");
      return;
    }
    this.applyLocal(writes);
    const n = await this.runBatch(`filling ${writes.length} cells`, async (progress) => {
      progress(0, writes.length);
      return this.engine.apply(`fill ${dir}`, writes, progress);
    });
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
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT") return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    this.pasteText(text);
  }

  private pasteText(text: string) {
    if (!this.head) return;
    const grid = parseClipboardTable(text);
    const start = this.selRange() ?? { r1: this.head.row, c1: this.head.col, r2: 0, c2: 0 };
    const writes: { file: TFile; key: string; value: unknown }[] = [];
    grid.forEach((line, dr) => {
      line.forEach((cell, dc) => {
        const ri = start.r1 + dr;
        const ci = start.c1 + dc;
        if (ri >= this.rows.length || ci >= this.cols.length) return;
        if (this.cols[ci].kind !== "prop") return;
        const row = this.rows[ri];
        writes.push({
          file: row.file,
          key: this.cols[ci].key,
          value: parseInput(cell, row.fm[this.cols[ci].key]),
        });
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
    if (col?.kind === "prop") {
      menu.addItem((i) =>
        i.setTitle("Zoom cell…").setIcon("maximize-2").onClick(() => {
          const row = this.rows[ri];
          if (!row) return;
          new ZoomValueModal(
            this.app,
            `${col.key} — ${row.file.basename}`,
            valueToDisplay(row.fm[col.key]),
            async (text) => {
              const value = parseInput(text, row.fm[col.key]);
              this.applyLocal([{ file: row.file, key: col.key, value }]);
              await this.engine.apply(`zoom edit ${col.key}`, [
                { file: row.file, key: col.key, value },
              ]);
            }
          ).open();
        })
      );
      menu.addItem((i) =>
        i.setTitle(`Hide column "${col.key}"`).setIcon("eye-off").onClick(() => void this.hideColumn(col.key))
      );
    }
    menu.showAtMouseEvent(e);
  }

  // ------------------------------------------------------------ find/replace

  private openFindReplace() {
    new FindReplaceModal(this).open();
  }

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

  cellsForColumn(key: string): { ri: number; key: string }[] {
    const out: { ri: number; key: string }[] = [];
    for (let ri = 0; ri < this.rows.length; ri++) out.push({ ri, key });
    return out;
  }

  allPropCells(): { ri: number; key: string }[] {
    const out: { ri: number; key: string }[] = [];
    const keys = this.store?.propColumns ?? [];
    for (let ri = 0; ri < this.rows.length; ri++) for (const key of keys) out.push({ ri, key });
    return out;
  }

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
      const row = this.rows[ri];
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

  /** Reorder: place dragged column at the target's position. */
  async moveColumn(draggedId: string, targetId: string) {
    const ids = this.cols.slice(1).map((c) => colId(c));
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    this.cfg().order = ids;
    await this.plugin.saveSettings();
    await this.render();
  }

  /** Re-create the store (fresh event wiring + full recompile). Used when
   * heading columns change out from under it, e.g. applying a named view. */
  reattachStore() {
    this.resetRowOrder();
    this.attachStore();
  }

  /** Forget the frozen display order; next render re-derives it. */
  private resetRowOrder() {
    this.frozenPathOrder = null;
    this.pinnedNew.clear();
  }

  /** Re-decide which rows the filter keeps (used by ↺ / recompile). */
  private resetFilterMembership() {
    this.stickyRows = null;
  }

  /** Duplicate a note: full content copy as "name (copy).md" (numbered when
   * taken). TODO (logged): settings-driven naming template. */
  async duplicateNote(file: TFile) {
    const dir = file.parent?.path === "/" ? "" : file.parent?.path ?? "";
    let name = `${file.basename} (copy)`;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(`${dir ? dir + "/" : ""}${name}.md`))
      name = `${file.basename} (copy ${n++})`;
    const path = `${dir ? dir + "/" : ""}${name}.md`;
    try {
      const content = await this.app.vault.read(file);
      await this.app.vault.create(path, content);
      new Notice(`GridSense: duplicated to "${name}"`);
    } catch (e) {
      new Notice(`GridSense: duplicate failed: ${String(e)}`);
    }
  }

  /** Current effective width of a column, and a setter that persists it. */
  currentWidth(c: ColumnSpec): number {
    return this.cfg().widths?.[colId(c)] ?? this.colWidth(c);
  }

  async setColumnWidth(c: ColumnSpec, px: number | null) {
    const cfg = this.cfg();
    cfg.widths = cfg.widths ?? {};
    if (px === null) delete cfg.widths[colId(c)];
    else cfg.widths[colId(c)] = Math.max(MIN_COL_PX, px);
    await this.plugin.saveSettings();
    await this.render();
  }

  /** Property-name suggestions: this grid's columns, then the whole vault's
   * known properties (from Obsidian's type manager, defensively probed). */
  propertyNameSuggestions(): string[] {
    const seen = new Set<string>(this.store?.propColumns ?? []);
    try {
      const mtm = (
        this.app as unknown as {
          metadataTypeManager?: { getAllProperties?: () => Record<string, unknown> };
        }
      ).metadataTypeManager;
      for (const k of Object.keys(mtm?.getAllProperties?.() ?? {})) seen.add(k);
    } catch {
      /* undocumented API — suggestions just stay folder-local */
    }
    return [...seen].sort();
  }

  /** Add a property (empty value, key kept) to every note in the grid. */
  async addColumn(name: string) {
    const key = name.trim();
    if (!key) return;
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      new Notice("GridSense: unsafe property name");
      return;
    }
    const writes = this.store!.rows
      .filter((r) => !(key in r.fm))
      .map((r) => ({ file: r.file, key, value: null as unknown }));
    if (!writes.length) {
      new Notice(`GridSense: every note already has "${key}"`);
      return;
    }
    this.applyLocal(writes);
    const n = await this.engine.apply(`add column "${key}"`, writes);
    new Notice(`GridSense: added "${key}" to ${n} note${n === 1 ? "" : "s"} (⌘Z to undo)`);
    await this.render();
  }

  /** Delete a property from every note in the grid (confirmed + undoable). */
  private confirmDeleteColumn(key: string) {
    const count = this.store!.rows.filter((r) => key in r.fm).length;
    new ConfirmModal(
      this.app,
      `Delete column "${key}"?`,
      `This deletes the "${key}" property AND its values from ${count} note${count === 1 ? "" : "s"} in this grid. ⌘Z undoes it while this tab is open, and the edit log keeps a permanent record.`,
      "Delete property",
      async () => {
        const writes = this.store!.rows
          .filter((r) => key in r.fm)
          .map((r) => ({ file: r.file, key, value: undefined as unknown }));
        this.applyLocal(writes);
        const n = await this.engine.apply(`delete column "${key}"`, writes);
        new Notice(`GridSense: deleted "${key}" from ${n} note${n === 1 ? "" : "s"}`);
        await this.render();
      }
    ).open();
  }

  async renameColumn(key: string, display: string) {
    const cfg = this.cfg();
    cfg.rename = cfg.rename ?? {};
    if (display && display !== key) cfg.rename[key] = display;
    else delete cfg.rename[key];
    await this.plugin.saveSettings();
    await this.render();
  }

  private async setHiddenInternal(key: string, hidden: boolean) {
    const cfg = this.cfg();
    cfg.hidden = cfg.hidden.filter((k) => k !== key);
    if (hidden) cfg.hidden.push(key);
    await this.plugin.saveSettings();
    await this.render();
  }

  // --------------------------------------------------- per-column filters

  /**
   * Column filters currently in force, paired with their column. Filters on
   * hidden columns are deliberately inert (the column isn't in `this.cols`) —
   * the config keeps them, so unhiding restores the filter.
   */
  private activeColFilters(): [ColumnSpec, ColumnFilter][] {
    const cfg = this.cfg();
    if (cfg.showColumnFilters === false) return [];
    const map = cfg.colFilters ?? {};
    const out: [ColumnSpec, ColumnFilter][] = [];
    for (const c of this.cols) {
      const f = map[colId(c)];
      if (isColFilterActive(f)) out.push([c, f]);
    }
    return out;
  }

  private openColumnFilter(c: ColumnSpec, anchor: HTMLElement) {
    this.filterPop?.close();
    const key = colId(c);
    // Excel semantics: the value list reflects the other columns' filters but
    // NOT this one's, so you can always re-check what you just excluded.
    const others = this.activeColFilters().filter(([o]) => colId(o) !== key);
    const counts = new Map<string, number>();
    let blankCount = 0;
    for (const r of this.colFilterBase) {
      if (!others.every(([o, f]) => passesColFilter(cellValues(r, o), f))) continue;
      const vals = cellValues(r, c);
      if (vals.every((v) => v === "")) {
        blankCount++;
        continue;
      }
      for (const v of new Set(vals)) if (v !== "") counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const distinct = [...counts.entries()]
      .map(([text, count]) => ({ text, count }))
      .sort((a, b) => a.text.localeCompare(b.text, undefined, { numeric: true }));
    const shown = c.kind === "prop" ? this.cfg().rename?.[c.key] ?? c.key : c.key;
    const pop = new ColumnFilterPopover({
      app: this.app,
      anchor,
      column: c,
      label: c.kind === "file" ? "File name" : shown,
      distinct,
      blankCount,
      current: this.cfg().colFilters?.[key],
      onChange: (f) => this.setColumnFilter(key, f),
      onSort: (dir) => {
        this.cfg().sort = { key: c.key, dir };
        this.resetRowOrder();
        this.saveDebounced();
        void this.render();
      },
    });
    this.filterPop = pop;
    // The dropdown outlives its <th> (every change re-renders the table), so it
    // closes on grid scroll instead of trailing a destroyed anchor. The
    // listener targets THIS popover, not whatever is open when it fires.
    const onScroll = () => {
      pop.close();
      if (this.filterPop === pop) this.filterPop = null;
    };
    this.scrollerEl?.addEventListener("scroll", onScroll, { once: true });
  }

  private setColumnFilter(key: string, f: ColumnFilter | undefined) {
    const cfg = this.cfg();
    const map = cfg.colFilters ?? {};
    if (f) map[key] = f;
    else delete map[key];
    if (Object.keys(map).length) cfg.colFilters = map;
    else delete cfg.colFilters;
    this.stickyRows = null; // a changed filter re-decides membership
    this.resetRowOrder();
    this.saveDebounced();
    this.requestRender();
  }

  /**
   * Mod+Shift+L, Excel's autofilter toggle: hides the funnel buttons and drops
   * every column filter (that clearing is the point of the toggle). Undoable,
   * so turning it off by accident doesn't cost the filter set.
   */
  async toggleColumnFilters() {
    const cfg = this.cfg();
    const on = cfg.showColumnFilters !== false;
    const saved = cfg.colFilters ? JSON.parse(JSON.stringify(cfg.colFilters)) : undefined;
    const set = async (show: boolean, filters: Record<string, ColumnFilter> | undefined) => {
      const c = this.cfg();
      if (show) delete c.showColumnFilters;
      else c.showColumnFilters = false;
      if (filters) c.colFilters = filters;
      else delete c.colFilters;
      this.filterPop?.close();
      this.stickyRows = null;
      this.resetRowOrder();
      await this.plugin.saveSettings();
      await this.render();
    };
    await set(!on, on ? undefined : saved);
    const cleared = on && saved && Object.keys(saved).length;
    this.engine.pushUi(
      on ? "hide column filters" : "show column filters",
      () => set(on, saved),
      () => set(!on, on ? undefined : saved)
    );
    new Notice(
      on
        ? `GridSense: column filters off${cleared ? " — filters cleared, ⌘Z to undo" : ""}`
        : "GridSense: column filters on"
    );
  }

  /** Drop every per-column filter but keep the buttons. */
  async clearColumnFilters() {
    const cfg = this.cfg();
    if (!cfg.colFilters) {
      new Notice("GridSense: no column filters set");
      return;
    }
    const saved = JSON.parse(JSON.stringify(cfg.colFilters)) as Record<string, ColumnFilter>;
    const set = async (filters: Record<string, ColumnFilter> | undefined) => {
      const c = this.cfg();
      if (filters) c.colFilters = filters;
      else delete c.colFilters;
      this.stickyRows = null;
      this.resetRowOrder();
      await this.plugin.saveSettings();
      await this.render();
    };
    await set(undefined);
    this.engine.pushUi("clear column filters", () => set(saved), () => set(undefined));
    new Notice("GridSense: cleared column filters — ⌘Z to undo");
  }

  async hideColumn(key: string) {
    await this.setHiddenInternal(key, true);
    this.engine.pushUi(
      `hide column "${key}"`,
      () => this.setHiddenInternal(key, false),
      () => this.setHiddenInternal(key, true)
    );
    new Notice(`GridSense: hid "${key}" — ⌘Z to undo`);
  }

  async setColumnHidden(key: string, hidden: boolean) {
    await this.setHiddenInternal(key, hidden);
    this.engine.pushUi(
      `${hidden ? "hide" : "show"} column "${key}"`,
      () => this.setHiddenInternal(key, !hidden),
      () => this.setHiddenInternal(key, hidden)
    );
  }

  private openColumnsModal() {
    new ColumnsModal(this).open();
  }

  allPropertyKeys(): string[] {
    return this.store?.propColumns ?? [];
  }

  scopeFolder(): string {
    return this.folder;
  }

  refresh(): Promise<void> {
    return this.render();
  }

  // --------------------------------------------------------------- commands
  // Thin wrappers so grid actions can be bound to user hotkeys.

  commandFill(dir: "down" | "right") {
    void this.fill(dir);
  }
  commandFindReplace() {
    this.openFindReplace();
  }
  commandUndo() {
    void this.undo();
  }
  commandRedo() {
    void this.engine.redo();
  }
  commandToggleWrap() {
    const cfg = this.cfg();
    cfg.wrap = !cfg.wrap;
    this.saveDebounced();
    void this.render();
    new Notice(`GridSense: word wrap ${cfg.wrap ? "on" : "off"}`);
  }
  commandAddColumn() {
    new NewColumnModal(this).open();
  }
  commandColumns() {
    this.openColumnsModal();
  }
  commandJumpToColumn() {
    new JumpToColumnModal(this).open();
  }

  /** Column labels in display order (for the jump picker). */
  columnChoices(): { label: string; index: number }[] {
    return this.cols.map((c, index) => ({
      label:
        c.kind === "file"
          ? "file (note name)"
          : c.kind === "heading"
            ? `# ${c.key}`
            : c.kind === "formula"
              ? `ƒ ${c.key}`
              : this.cfg().rename?.[c.key] ?? c.key,
      index,
    }));
  }

  /**
   * Scroll a column into view and put the cursor on it — long grids are
   * miserable to scroll horizontally by hand.
   */
  jumpToColumn(index: number) {
    const scroller = this.scrollerEl;
    if (!scroller || index < 0 || index >= this.cols.length) return;
    const cols = Array.from(this.tableEl?.querySelectorAll("colgroup col") ?? []);
    let left = 0;
    for (let i = 0; i <= index; i++) left += parseInt((cols[i] as HTMLElement)?.style.width) || 0;
    const width = parseInt((cols[index + 1] as HTMLElement)?.style.width) || 160;
    // Frozen columns cover the left edge, so land the column just past them.
    const frozenWidth = this.frozenLeft.length
      ? this.frozenLeft[this.frozenLeft.length - 1] +
        (parseInt((cols[this.frozenLeft.length] as HTMLElement)?.style.width) || 0)
      : 44;
    const target = Math.max(0, left - frozenWidth);
    scroller.scrollTo({ left: target, behavior: "smooth" });
    const row = Math.max(0, this.head?.row ?? this.winStart);
    this.setSel({ row, col: index });
    const label = this.columnChoices()[index]?.label ?? "column";
    this.updateStatus(`jumped to ${label}`);
    void width;
  }
  commandFilters() {
    new FiltersModal(this).open();
  }

  /**
   * Is the live config still identical to the applied view? Comparison is
   * order-insensitive and treats "missing" and "empty" as the same, so cosmetic
   * differences don't read as unsaved changes.
   */
  private viewState(): { name: string; drifted: boolean } {
    const cfg = this.cfg();
    const saved = this.activeView ? cfg.views?.[this.activeView] : undefined;
    if (!saved) return { name: "", drifted: false };
    const canon = (o: unknown): string => {
      const norm = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(norm);
        if (v && typeof v === "object") {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(v as Record<string, unknown>).sort()) {
            const val = norm((v as Record<string, unknown>)[k]);
            // undefined / null / [] / "" all mean "not set"
            if (val === undefined || val === null || val === "") continue;
            if (Array.isArray(val) && !val.length) continue;
            out[k] = val;
          }
          return out;
        }
        return v;
      };
      return JSON.stringify(norm(o));
    };
    // `sections` is modal chrome — collapsing a section isn't a view change.
    const { views: _a, sections: _sa, ...live } = cfg;
    const { views: _b, sections: _sb, ...snap } = saved as FolderConfig;
    return { name: this.activeView, drifted: canon(live) !== canon(snap) };
  }

  /** Rebuild the toolbar's view dropdown from the saved views. */
  syncViewPicker() {
    const sel = this.viewSelectEl;
    if (!sel) return;
    const views = Object.keys(this.cfg().views ?? {}).sort();
    const state = this.viewState();
    sel.empty();
    // The first entry describes what you're looking at RIGHT NOW: either an
    // untouched view, that view with unsaved changes, or a setup that isn't a
    // saved view at all. It is not a "default view" — there is no such thing.
    if (!state.name)
      sel.createEl("option", { value: "", text: "Current setup (unsaved)" });
    else if (state.drifted)
      sel.createEl("option", { value: "", text: `${state.name} — modified` });
    else sel.createEl("option", { value: state.name, text: state.name });

    for (const v of views)
      if (v !== state.name || state.drifted) sel.createEl("option", { value: v, text: v });

    if (state.name && state.drifted) {
      sel.createEl("option", { value: "__update", text: `⤓ Update "${state.name}"` });
      sel.createEl("option", { value: "__revert", text: `↩ Revert to "${state.name}"` });
    }
    sel.createEl("option", { value: "__save", text: "＋ Save current as view…" });
    sel.createEl("option", { value: "__manage", text: "⚙ Manage views…" });
    sel.value = state.name && !state.drifted ? state.name : "";
    sel.toggleClass("gridsense-view-drift", state.drifted);
    sel.setAttr(
      "title",
      state.name
        ? state.drifted
          ? `"${state.name}" with unsaved changes — update it, revert, or save a new view`
          : `Showing the saved view "${state.name}"`
        : "This setup isn't saved as a view yet"
    );
  }

  /** Apply a saved view: columns, sort, filters, widths, wrap, formulas. */
  async applyView(name: string) {
    const cfg = this.cfg();
    const saved = cfg.views?.[name];
    if (!saved) return;
    // REPLACE, don't merge: a setting the view doesn't mention (no sort, no
    // filter) must be cleared, otherwise the previous view's sort leaks in.
    const keepSections = cfg.sections;
    for (const k of Object.keys(cfg))
      if (k !== "views") delete (cfg as unknown as Record<string, unknown>)[k];
    Object.assign(cfg, structuredClone(saved), {
      views: cfg.views,
      sections: keepSections,
      headingColumns: saved.headingColumns ?? [],
      hidden: saved.hidden ?? [],
    });
    this.activeView = name;
    await this.plugin.saveSettings();
    this.stickyRows = null;
    this.resetRowOrder();
    this.reattachStore(); // heading columns may differ
    await this.render();
    this.syncViewPicker();
    new Notice(`GridSense: view "${name}"`);
  }

  /** Save the current setup as a named view. */
  async saveView(name: string) {
    const cfg = this.cfg();
    cfg.views = cfg.views ?? {};
    const { views: _omit, sections: _chrome, ...rest } = cfg;
    cfg.views[name] = structuredClone(rest);
    this.activeView = name;
    await this.plugin.saveSettings();
    this.syncViewPicker();
    new Notice(`GridSense: saved view "${name}"`);
  }

  async deleteView(name: string) {
    const cfg = this.cfg();
    if (cfg.views) delete cfg.views[name];
    if (this.activeView === name) this.activeView = "";
    await this.plugin.saveSettings();
    this.syncViewPicker();
  }

  viewNames(): string[] {
    return Object.keys(this.cfg().views ?? {}).sort();
  }

  /** Forget any manual column drag order and fall back to note order. */
  async resetColumnOrder() {
    const cfg = this.cfg();
    delete cfg.order;
    await this.plugin.saveSettings();
    this.reattachStore();
    await this.render();
    new Notice("GridSense: column order reset to the order properties appear in your notes");
  }

  /** Filters changed: re-decide membership and repaint. */
  async filtersChanged() {
    this.stickyRows = null;
    this.resetRowOrder();
    await this.plugin.saveSettings();
    await this.render();
  }
  /** History scoped to one note / property / cell, with restore buttons. */
  async openScopedHistory(scope: { path?: string; key?: string; label: string }) {
    const all = await readHistory(this.app, this.folder);
    const entries = filterHistory(all, scope);
    new HistoryLogModal(this.app, this.folder, entries, scope.label, async (change) => {
      const file = this.app.vault.getAbstractFileByPath(change.path);
      if (!(file instanceof TFile)) {
        new Notice("GridSense: that note no longer exists");
        return;
      }
      const write = { file, key: change.key, value: change.value };
      this.applyLocal([write]);
      await this.engine.apply(`restore ${change.key}`, [write]);
      new Notice(`GridSense: restored ${change.key} on "${file.basename}" (⌘Z to undo)`);
    }).open();
  }

  async commandHistory() {
    const entries = await readHistory(this.app, this.folder);
    new HistoryLogModal(this.app, this.folder, entries).open();
  }
  commandRecompile() {
    this.resetFilterMembership();
    this.resetRowOrder();
    this.attachStore();
    void this.render();
  }

  addHeadingColumn() {
    const files = this.store!.files();
    const options = allHeadings(this.app, files);
    new HeadingPickModal(this.app as never, options, async (heading) => {
      const cfg = this.cfg();
      if (!cfg.headingColumns.includes(heading)) {
        cfg.headingColumns.push(heading);
        await this.plugin.saveSettings();
      }
      this.attachStore();
      await this.render();
    }).open();
  }

  async removeHeadingColumn(heading: string) {
    const cfg = this.cfg();
    cfg.headingColumns = cfg.headingColumns.filter((h) => h !== heading);
    await this.plugin.saveSettings();
    this.attachStore();
    await this.render();
    this.engine.pushUi(
      `remove heading column "${heading}"`,
      async () => {
        const c = this.cfg();
        if (!c.headingColumns.includes(heading)) c.headingColumns.push(heading);
        await this.plugin.saveSettings();
        this.attachStore();
        await this.render();
      },
      async () => {
        const c = this.cfg();
        c.headingColumns = c.headingColumns.filter((h) => h !== heading);
        await this.plugin.saveSettings();
        this.attachStore();
        await this.render();
      }
    );
  }

  async removeFormulaColumn(name: string) {
    const cfg = this.cfg();
    const saved = (cfg.formulas ?? []).find((f) => f.name === name);
    cfg.formulas = (cfg.formulas ?? []).filter((f) => f.name !== name);
    await this.plugin.saveSettings();
    await this.render();
    if (!saved) return;
    this.engine.pushUi(
      `remove formula column "${name}"`,
      async () => {
        const c = this.cfg();
        c.formulas = [...(c.formulas ?? []).filter((f) => f.name !== name), saved];
        await this.plugin.saveSettings();
        await this.render();
      },
      async () => {
        const c = this.cfg();
        c.formulas = (c.formulas ?? []).filter((f) => f.name !== name);
        await this.plugin.saveSettings();
        await this.render();
      }
    );
  }

  private updateStatus(text: string) {
    this.statusEl?.setText(text);
  }
}

// ------------------------------------------------------------------ suggests

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
    this.limit = 0;
  }

  getSuggestions(query: string): ScopeOption[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.options;
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

class ColumnsModal extends Modal {
  constructor(private view: GridView) {
    super(view.app);
  }

  onOpen() {
    this.titleEl.setText("Columns & views");
    this.renderBody();
  }

  private cfg(): FolderConfig {
    return this.view.plugin.folderConfig(this.view.scopeFolder());
  }

  /**
   * A collapsible section. Open/closed is remembered per section across
   * openings (plugin settings, so it follows you between grids — the state is
   * chrome, not grid data), with sensible defaults so the modal opens short.
   */
  private section(parent: HTMLElement, title: string, key: string, defaultOpen: boolean): HTMLElement {
    // This grid's choice wins; otherwise the vault-wide default; otherwise the
    // built-in default for that section.
    const perGrid = this.cfg().sections ?? {};
    const globals = this.view.plugin.settings.columnsSectionDefaults ?? {};
    const open = perGrid[key] ?? globals[key] ?? defaultOpen;
    const wrap = parent.createDiv({ cls: "gridsense-section" });
    const head = wrap.createDiv({ cls: "setting-item-heading gridsense-section-head" });
    const chevron = head.createSpan({ cls: "gridsense-section-chevron" });
    setIcon(chevron, open ? "chevron-down" : "chevron-right");
    head.createSpan({ text: title });
    const body = wrap.createDiv({ cls: "gridsense-section-body" });
    if (!open) body.hide();
    head.addEventListener("click", async () => {
      const nowOpen = !body.isShown();
      body.toggle(nowOpen);
      setIcon(chevron, nowOpen ? "chevron-down" : "chevron-right");
      const cfg = this.cfg();
      cfg.sections = { ...(cfg.sections ?? {}), [key]: nowOpen };
      await this.view.plugin.saveSettings();
      this.view.syncViewPicker();
    });
    return body;
  }

  private renderBody() {
    const root = this.contentEl;
    root.empty();
    const cfg = this.cfg();

    // Views: apply/save/delete named snapshots of this whole config.
    let c = this.section(root, "Views", "views", true);
    c.createDiv({
      cls: "gridsense-props-hint",
      text: "A view remembers this grid's columns, order, widths, sort, filters, wrap, limit and formulas. Switch between them from the toolbar dropdown.",
    });
    const views = cfg.views ?? {};
    const names = Object.keys(views).sort();
    for (const n of names)
      new Setting(c)
        .setName(n)
        .addButton((b) =>
          b.setButtonText("Apply").onClick(async () => {
            this.close();
            await this.view.applyView(n);
          })
        )
        .addButton((b) =>
          b.setButtonText("Overwrite").onClick(async () => {
            await this.view.saveView(n);
            this.renderBody();
          })
        )
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("Delete view").onClick(async () => {
            await this.view.deleteView(n);
            this.renderBody();
          })
        );
    if (!names.length)
      c.createDiv({ cls: "gridsense-props-empty", text: "No saved views yet." });
    let viewName = "";
    new Setting(c)
      .setName("Save current as view")
      .addText((t) => {
        t.setPlaceholder("view name");
        t.onChange((v) => (viewName = v));
      })
      .addButton((b) =>
        b.setButtonText("Save").onClick(async () => {
          const name = viewName.trim();
          if (!name) return;
          await this.view.saveView(name);
          this.renderBody();
        })
      );

    c = this.section(root, "Properties", "properties", true);
    new Setting(c)
      .setName("Column order")
      .setDesc(
        cfg.order?.length
          ? "Custom order — you've dragged columns in this grid."
          : "Following the order the properties appear in your notes."
      )
      .addButton((b) =>
        b
          .setButtonText("Reset to note order")
          .setDisabled(!cfg.order?.length)
          .onClick(async () => {
            await this.view.resetColumnOrder();
            this.renderBody();
          })
      );
    new Setting(c).addButton((b) =>
      b.setButtonText("Add property column…").onClick(() => {
        this.close();
        new NewColumnModal(this.view).open();
      })
    );
    for (const key of this.view.allPropertyKeys()) {
      const widget = widgetForKey(this.view.app, key);
      const setting = new Setting(c).setName(key).addToggle((t) =>
        t.setValue(!cfg.hidden.includes(key)).onChange(async (v) => {
          await this.view.setColumnHidden(key, !v);
        })
      );
      // Property-type icon, matching Obsidian's own properties UI.
      const icon = createSpan({ cls: "gridsense-colicon" });
      setIcon(icon, iconForWidget(widget));
      icon.setAttr("title", widget ? `Type: ${widget}` : "Type: text (unset)");
      setting.nameEl.prepend(icon);
    }

    c = this.section(root, "Heading columns", "headings", false);
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

    c = this.section(root, "Formula columns", "formulas", false);
    for (const f of [...(cfg.formulas ?? [])]) {
      new Setting(c)
        .setName(`ƒ ${f.name}`)
        .setDesc(
          `${f.type.toUpperCase()}: ${f.lookupProp || f.name} → ${f.searchDir || "(vault)"}.${f.matchProp}` +
            (f.returnHeading ? ` ⇒ # ${f.returnHeading}` : f.returnProp ? ` ⇒ ${f.returnProp}` : "")
        )
        .addExtraButton((b) =>
          b.setIcon("pencil").setTooltip("Edit").onClick(() => {
            this.close();
            new FormulaBuilderModal(this.view.app, this.view.plugin, this.view.scopeFolder(), f, () =>
              this.view.refresh()
            ).open();
          })
        )
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("Remove").onClick(async () => {
            await this.view.removeFormulaColumn(f.name);
            this.renderBody();
          })
        );
    }
    new Setting(c).addButton((b) =>
      b.setButtonText("Add formula column…").onClick(() => {
        this.close();
        new FormulaBuilderModal(this.view.app, this.view.plugin, this.view.scopeFolder(), null, () =>
          this.view.refresh()
        ).open();
      })
    );

    new Setting(c)
      .setName("Column width cap")
      .setDesc(
        `Widest an auto-sized column gets in this grid (px). Columns you drag-resize keep their own width. Default ${MAX_COL_PX}.`
      )
      .addText((t) => {
        t.setPlaceholder(String(MAX_COL_PX));
        t.setValue(cfg.widthCap !== undefined ? String(cfg.widthCap) : "");
        t.onChange(async (v) => {
          const trimmed = v.trim();
          if (trimmed === "") delete cfg.widthCap;
          else {
            const n = parseInt(trimmed);
            if (Number.isNaN(n) || n < MIN_COL_PX) return;
            cfg.widthCap = n;
          }
          await this.view.plugin.saveSettings();
          await this.view.refresh();
        });
      });

    new Setting(c)
      .setName("Freeze columns")
      .setDesc("Keep the first N columns pinned while scrolling sideways. 0 or empty = none.")
      .addText((t) => {
        t.setPlaceholder("0");
        t.setValue(cfg.freezeCols ? String(cfg.freezeCols) : "");
        t.onChange(async (v) => {
          const n = parseInt(v.trim());
          cfg.freezeCols = Number.isNaN(n) || n <= 0 ? undefined : n;
          await this.view.plugin.saveSettings();
          await this.view.refresh();
        });
      });
    new Setting(c)
      .setName("Freeze rows")
      .setDesc("Keep the first N rows pinned below the header. 0 or empty = none.")
      .addText((t) => {
        t.setPlaceholder("0");
        t.setValue(cfg.freezeRows ? String(cfg.freezeRows) : "");
        t.onChange(async (v) => {
          const n = parseInt(v.trim());
          cfg.freezeRows = Number.isNaN(n) || n <= 0 ? undefined : n;
          await this.view.plugin.saveSettings();
          await this.view.refresh();
        });
      });

    c = this.section(root, "Property tools", "tools", false);
    if (toolboxInstalled(this.view.app)) {
      c.createDiv({
        cls: "gridsense-props-hint",
        text: "Provided by Bases Toolbox — GridSense launches its tools rather than duplicating them.",
      });
      for (const tool of TOOLBOX_TOOLS)
        new Setting(c).setName(tool.title).addButton((b) =>
          b.setButtonText("Open").onClick(() => {
            this.close();
            (
              this.view.app as unknown as {
                commands: { executeCommandById: (id: string) => boolean };
              }
            ).commands.executeCommandById(`bases-toolbox:${tool.command}`);
          })
        );
    } else {
      c.createDiv({
        cls: "gridsense-props-hint",
        text: "Install the Bases Toolbox plugin to get the format doctor, property index, duplicate finder, alias/allowed-value audits, inline-field migration and rollups here.",
      });
    }

    c = this.section(root, "Rows & layout", "rows", false);
    new Setting(c)
      .setName("Follow the default section layout")
      .setDesc("Forget this grid's collapse choices and use the plugin defaults again.")
      .addButton((b) =>
        b
          .setButtonText("Reset sections")
          .setDisabled(!Object.keys(cfg.sections ?? {}).length)
          .onClick(async () => {
            delete cfg.sections;
            await this.view.plugin.saveSettings();
            this.renderBody();
          })
      );

    new Setting(c)
      .setName("Row limit")
      .setDesc("0 = unlimited (the default — virtualized rendering keeps big grids fast). The row counter shows when a limit is trimming the grid.")
      .addText((t) => {
        t.setPlaceholder(`plugin default (${this.view.plugin.settings.defaultRowLimit || "unlimited"})`);
        t.setValue(cfg.limit !== undefined ? String(cfg.limit) : "");
        t.onChange(async (v) => {
          const trimmed = v.trim();
          if (trimmed === "") {
            delete cfg.limit;
            await this.view.plugin.saveSettings();
            await this.view.refresh();
            return;
          }
          const n = parseInt(trimmed);
          if (!Number.isNaN(n) && n >= 0) {
            cfg.limit = n;
            await this.view.plugin.saveSettings();
            await this.view.refresh();
          }
        });
      });
  }
}

/** Bases-style stacked filters: any number of property conditions, all/any. */
class FiltersModal extends Modal {
  constructor(private view: GridView) {
    super(view.app);
  }

  onOpen() {
    this.titleEl.setText("Filters");
    this.renderBody();
  }

  private cfg(): FolderConfig {
    return this.view.plugin.folderConfig(this.view.scopeFolder());
  }

  /**
   * A collapsible section. Open/closed is remembered per section across
   * openings (plugin settings, so it follows you between grids — the state is
   * chrome, not grid data), with sensible defaults so the modal opens short.
   */
  private section(parent: HTMLElement, title: string, key: string, defaultOpen: boolean): HTMLElement {
    // This grid's choice wins; otherwise the vault-wide default; otherwise the
    // built-in default for that section.
    const perGrid = this.cfg().sections ?? {};
    const globals = this.view.plugin.settings.columnsSectionDefaults ?? {};
    const open = perGrid[key] ?? globals[key] ?? defaultOpen;
    const wrap = parent.createDiv({ cls: "gridsense-section" });
    const head = wrap.createDiv({ cls: "setting-item-heading gridsense-section-head" });
    const chevron = head.createSpan({ cls: "gridsense-section-chevron" });
    setIcon(chevron, open ? "chevron-down" : "chevron-right");
    head.createSpan({ text: title });
    const body = wrap.createDiv({ cls: "gridsense-section-body" });
    if (!open) body.hide();
    head.addEventListener("click", async () => {
      const nowOpen = !body.isShown();
      body.toggle(nowOpen);
      setIcon(chevron, nowOpen ? "chevron-down" : "chevron-right");
      const cfg = this.cfg();
      cfg.sections = { ...(cfg.sections ?? {}), [key]: nowOpen };
      await this.view.plugin.saveSettings();
      this.view.syncViewPicker();
    });
    return body;
  }

  private renderBody() {
    const c = this.contentEl;
    c.empty();
    const cfg = this.cfg();
    cfg.filters = cfg.filters ?? { conjunction: "and", conditions: [] };
    const f = cfg.filters;

    new Setting(c)
      .setName("Match")
      .setDesc("How the conditions below combine.")
      .addDropdown((d) => {
        d.addOption("and", "all conditions (AND)");
        d.addOption("or", "any condition (OR)");
        d.setValue(f.conjunction).onChange(async (v) => {
          f.conjunction = v as "and" | "or";
          await this.view.filtersChanged();
        });
      });

    if (!f.conditions.length)
      c.createDiv({ cls: "gridsense-props-empty", text: "No conditions — the grid shows every note in scope." });

    f.conditions.forEach((cond, i) => {
      new Setting(c)
        .setName(i === 0 ? "Where" : f.conjunction === "or" ? "or" : "and")
        .addText((t) => {
          t.setPlaceholder("property");
          t.setValue(cond.prop);
          new ListSuggest(this.view.app, t.inputEl, () => this.view.propertyNameSuggestions());
          t.onChange(async (v) => {
            cond.prop = v.trim();
            await this.view.filtersChanged();
          });
        })
        .addDropdown((d) => {
          for (const op of ["=", "!=", ">", "<", ">=", "<=", "contains", "empty", "not-empty"])
            d.addOption(op, op);
          d.setValue(cond.op).onChange(async (v) => {
            cond.op = v as Condition["op"];
            await this.view.filtersChanged();
          });
        })
        .addText((t) => {
          t.setPlaceholder("value");
          t.setValue(cond.value);
          t.onChange(async (v) => {
            cond.value = v;
            await this.view.filtersChanged();
          });
        })
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("Remove").onClick(async () => {
            f.conditions.splice(i, 1);
            await this.view.filtersChanged();
            this.renderBody();
          })
        );
    });

    new Setting(c)
      .addButton((b) =>
        b.setButtonText("Add condition").onClick(async () => {
          f.conditions.push({ prop: "", op: "=", value: "" });
          await this.view.filtersChanged();
          this.renderBody();
        })
      )
      .addButton((b) =>
        b.setButtonText("Clear all").onClick(async () => {
          f.conditions = [];
          await this.view.filtersChanged();
          this.renderBody();
        })
      );
  }
}

/** Type-to-jump column picker — long grids are painful to scroll sideways. */
class JumpToColumnModal extends FuzzySuggestModal<{ label: string; index: number }> {
  constructor(private view: GridView) {
    super(view.app);
    this.setPlaceholder("Jump to column…");
  }

  getItems() {
    return this.view.columnChoices();
  }

  getItemText(item: { label: string; index: number }) {
    return item.label;
  }

  onChooseItem(item: { label: string; index: number }) {
    this.view.jumpToColumn(item.index);
  }
}

class SaveViewModal extends Modal {
  constructor(private view: GridView) {
    super(view.app);
  }

  onOpen() {
    this.titleEl.setText("Save current setup as a view");
    let value = "";
    new Setting(this.contentEl)
      .setName("View name")
      .setDesc("Captures columns, order, widths, sort, filters, wrap, limit and formulas.")
      .addText((t) => {
        t.setPlaceholder("e.g. Triage");
        t.onChange((v) => (value = v));
        window.setTimeout(() => t.inputEl.focus(), 0);
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && value.trim()) {
            this.close();
            void this.view.saveView(value.trim());
          }
        });
      });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          if (!value.trim()) return;
          this.close();
          void this.view.saveView(value.trim());
        })
    );
  }
}

class NewColumnModal extends Modal {
  constructor(private view: GridView) {
    super(view.app);
  }

  onOpen() {
    this.titleEl.setText("Add column");
    let value = "";
    new Setting(this.contentEl)
      .setName("Property name")
      .setDesc("Adds this property (empty value) to every note in the grid — undoable.")
      .addText((t) => {
        new ListSuggest(this.view.app, t.inputEl, () => this.view.propertyNameSuggestions());
        t.onChange((v) => (value = v));
        window.setTimeout(() => t.inputEl.focus(), 0);
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && value.trim()) {
            this.close();
            void this.view.addColumn(value);
          }
        });
      });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Add")
        .setCta()
        .onClick(() => {
          if (!value.trim()) return;
          this.close();
          void this.view.addColumn(value);
        })
    );
  }
}

class ColumnWidthModal extends Modal {
  constructor(private view: GridView, private col: ColumnSpec) {
    super(view.app);
  }

  onOpen() {
    this.titleEl.setText(`Width — ${this.col.key}`);
    let value = String(Math.round(this.view.currentWidth(this.col)));
    new Setting(this.contentEl)
      .setName("Width in pixels")
      .setDesc("Overrides the auto-sized width for this column. Clear the field to go back to automatic.")
      .addText((t) => {
        t.setValue(value);
        t.onChange((v) => (value = v));
        window.setTimeout(() => {
          t.inputEl.focus();
          t.inputEl.select();
        }, 0);
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.commit(value);
          }
        });
      });
    new Setting(this.contentEl)
      .addButton((b) =>
        b.setButtonText("Automatic").onClick(() => {
          this.close();
          void this.view.setColumnWidth(this.col, null);
        })
      )
      .addButton((b) => b.setButtonText("Set").setCta().onClick(() => this.commit(value)));
  }

  private commit(value: string) {
    const n = parseInt(value.trim());
    this.close();
    void this.view.setColumnWidth(this.col, Number.isNaN(n) ? null : n);
  }
}

class RenameColumnModal extends Modal {
  constructor(private view: GridView, private key: string) {
    super(view.app);
  }

  onOpen() {
    this.titleEl.setText(`Display name for "${this.key}"`);
    let value = this.view.plugin.folderConfig(this.view.scopeFolder()).rename?.[this.key] ?? "";
    new Setting(this.contentEl)
      .setName("Shown as")
      .setDesc("Display only — the frontmatter property keeps its real name. Empty resets.")
      .addText((t) => {
        t.setValue(value);
        t.setPlaceholder(this.key);
        t.onChange((v) => (value = v));
        window.setTimeout(() => t.inputEl.focus(), 0);
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            this.close();
            void this.view.renameColumn(this.key, value.trim());
          }
        });
      });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          this.close();
          void this.view.renameColumn(this.key, value.trim());
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
