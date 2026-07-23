import {
  AbstractInputSuggest,
  App,
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
} from "obsidian";
import type GridSensePlugin from "./main";
import { GridStore } from "./store";
import { EditEngine, parseInput, valueToDisplay } from "./edits";
import { allHeadings } from "./headings";
import { HistoryLogModal, appendHistory, readHistory } from "./history-log";
import { CellRef, ColumnSpec, FolderConfig, FormulaSpec, Row, colId } from "./types";
import { evaluateFormulas } from "./formulas";
import { ZoomValueModal } from "./zoom";
import {
  ConfirmModal,
  FormulaBuilderModal,
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
  /** Excel-style order stability: once displayed, row order is frozen until
   * the user changes sort/filter/scope — edits and new rows never reshuffle. */
  private frozenPathOrder: string[] | null = null;
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
    mkBtn("↺", "Recompile from notes (also re-derives row order)", () => {
      this.resetRowOrder();
      this.attachStore();
      void this.render();
    });
    mkBtn("▦ columns", "Views, show/hide columns, heading & formula columns", () =>
      this.openColumnsModal()
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
    const filter = bar.createEl("input", {
      cls: "gridsense-filter",
      type: "search",
      attr: { placeholder: "filter rows…" },
    });
    filter.value = this.cfg().filter ?? "";
    const applyFilter = debounce(
      () => {
        this.cfg().filter = filter.value;
        this.resetRowOrder();
        this.saveDebounced();
        this.requestRender();
      },
      200,
      true
    );
    filter.addEventListener("input", applyFilter);

    this.pendingEl = bar.createSpan({
      cls: "gridsense-pending",
      text: "⟳ other files in this folder changed — grid refreshes when you finish editing",
    });
    this.pendingEl.hide();
    this.warnEl = bar.createEl("button", { cls: "gridsense-rowwarn" });
    this.warnEl.setAttr("title", "Open columns & views to hide columns or set a row limit");
    this.warnEl.addEventListener("click", () => this.openColumnsModal());
    this.warnEl.hide();
    this.rowCountEl = bar.createSpan({ cls: "gridsense-rowcount" });
    this.statusEl = bar.createSpan({ cls: "gridsense-status" });

    this.scrollerEl = content.createDiv({ cls: "gridsense-scroller" });
    this.scrollerEl.addEventListener("scroll", () => this.onScroll());
  }

  // ------------------------------------------------------------------ render

  async render() {
    if (!this.store || !this.scrollerEl) return;
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
    const needle = (cfg.filter ?? "").trim().toLowerCase();
    const specs = cfg.formulas ?? [];
    if (specs.length) await evaluateFormulas(this.app, specs, rows);
    if (needle) {
      rows = rows.filter((r) => {
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
    const parts = [`${this.cols.length - 1} columns`];
    if (needle) parts.push("filtered");
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
    return Math.max(MIN_COL_PX, Math.min(MAX_COL_PX, Math.round(maxLen * 7.2 + 24)));
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
    hr.createEl("th", { cls: "gridsense-rownum", text: "#" });
    const sort = this.cfg().sort;
    this.cols.forEach((c, ci) => {
      const shown = c.kind === "prop" ? this.cfg().rename?.[c.key] ?? c.key : c.key;
      const label =
        c.kind === "heading" ? `# ${shown}` : c.kind === "formula" ? `ƒ ${shown}` : shown;
      const th = hr.createEl("th", { cls: `gridsense-col-${c.kind}` });
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

    this.tbodyEl = table.createEl("tbody");
    this.winStart = -1;
    this.winEnd = -1;
    this.renderWindow(true);
    this.buildFooter(table);
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
    const name = (state["file"] ?? "").trim().replace(/[\\/:]+/g, "-");
    if (!name) {
      new Notice("GridSense: give the draft a note name (first column) to create it");
      return;
    }
    const path = `${this.folder ? this.folder + "/" : ""}${name}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice("GridSense: a note with that name already exists here");
      return;
    }
    let file: TFile;
    try {
      file = await this.app.vault.create(path, "---\n---\n");
    } catch (err) {
      new Notice(`GridSense: could not create note: ${String(err)}`);
      return;
    }
    const writes: { file: TFile; key: string; value: unknown }[] = [];
    for (const [key, text] of Object.entries(state)) {
      if (key === "file" || !text.trim()) continue;
      writes.push({ file, key, value: parseInput(text, undefined) });
    }
    if (writes.length) await this.engine.apply(`create ${name}`, writes);
    this.pinnedNew.set(path, which);
    this.drafts[which] = {};
    this.editing = false;
    this.draftFocusPending = which;
    new Notice(`GridSense: created "${name}"`);
    this.requestRender();
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
    for (let ri = start; ri < end; ri++) this.renderRow(tbody, ri);
    const spBot = tbody.createEl("tr", { cls: "gridsense-spacer" });
    spBot.createEl("td", {
      attr: {
        colspan: String(this.cols.length + 1),
        style: `height: ${Math.max(0, total - end) * this.rowH}px`,
      },
    });
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

  private renderRow(tbody: HTMLElement, ri: number) {
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
      menu.showAtMouseEvent(e);
    });
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
    td.setText(text);
    if (typeof v === "boolean") td.addClass("gridsense-bool");
    if (typeof v === "number") td.addClass("gridsense-num");
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
        i.setTitle(`Delete column "${c.key}"…`).setIcon("trash").onClick(() =>
          this.confirmDeleteColumn(c.key)
        )
      );
    }
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
    // ⌘D/⌘R/⌘F/⌘Z/⇧⌘Z/⌘Y are handled by the view's keymap Scope (see the
    // constructor) so they beat Obsidian's own hotkeys; not duplicated here.
    if (!mod && e.key.length === 1 && this.head) {
      this.beginEdit(this.head.row, this.head.col, e.key);
      e.preventDefault();
    }
  }

  // ------------------------------------------------------------------ editing

  private beginEdit(ri: number, ci: number, seed?: string) {
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
    input.focus();
    if (seed === undefined) input.select();
    const finish = (commit: boolean, thenMove?: { dr: number; dc: number }) => {
      if (!this.editing) return;
      this.editing = false;
      const text = input.value;
      this.paintCell(td, ri, ci);
      this.contentEl.focus();
      if (commit && text !== current) {
        const row = this.rows[ri];
        const value = parseInput(text, row.fm[c.key]);
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
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT") return;
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

  private renderBody() {
    const c = this.contentEl;
    c.empty();
    const cfg = this.cfg();

    // Views: apply/save/delete named snapshots of this whole config.
    c.createEl("div", { cls: "setting-item-heading", text: "Views" });
    const views = cfg.views ?? {};
    const names = Object.keys(views).sort();
    if (names.length) {
      new Setting(c)
        .setName("Apply view")
        .setDesc("Restores columns, sort, filter, widths, wrap")
        .addDropdown((d) => {
          d.addOption("", "— pick —");
          for (const n of names) d.addOption(n, n);
          d.onChange(async (n) => {
            if (!n) return;
            const v = views[n];
            Object.assign(cfg, structuredClone(v), { views: cfg.views });
            await this.view.plugin.saveSettings();
            this.view.reattachStore(); // heading columns may differ — recompile
            await this.view.refresh();
            this.renderBody();
            new Notice(`GridSense: applied view "${n}"`);
          });
        })
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("Delete a view").onClick(() => {
            const menu = new Menu();
            for (const n of names)
              menu.addItem((i) =>
                i.setTitle(`Delete "${n}"`).onClick(async () => {
                  delete cfg.views![n];
                  await this.view.plugin.saveSettings();
                  this.renderBody();
                })
              );
            menu.showAtMouseEvent(new MouseEvent("contextmenu"));
          })
        );
    }
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
          cfg.views = cfg.views ?? {};
          const { views: _omit, ...rest } = cfg;
          cfg.views[name] = structuredClone(rest);
          await this.view.plugin.saveSettings();
          this.renderBody();
          new Notice(`GridSense: saved view "${name}"`);
        })
      );

    c.createEl("div", { cls: "setting-item-heading", text: "Properties" });
    new Setting(c).addButton((b) =>
      b.setButtonText("Add property column…").onClick(() => {
        this.close();
        new NewColumnModal(this.view).open();
      })
    );
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

    c.createEl("div", { cls: "setting-item-heading", text: "Formula columns" });
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

    c.createEl("div", { cls: "setting-item-heading", text: "Rows" });
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
