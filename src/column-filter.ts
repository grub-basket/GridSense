import { App, setIcon } from "obsidian";
import { ColumnFilter, ColumnSpec, Condition, Row, SortDir, colId } from "./types";
import { valueToDisplay } from "./edits";
import { matchesText } from "./formulas";

/**
 * Excel-style per-column filtering: the value extraction, the predicate, and
 * the dropdown UI. The grid owns the config; this module owns the semantics.
 */

/**
 * A cell's values as filterable strings. List properties contribute one entry
 * per element so "tags contains work" is a checkbox, not a string match against
 * the joined display value.
 */
export function cellValues(row: Row, c: ColumnSpec): string[] {
  if (c.kind === "file") return [row.file.basename];
  if (c.kind === "heading") return [(row.headings[c.key] ?? "").trim()];
  if (c.kind === "formula") return [(row.formulas?.[c.key] ?? "").trim()];
  const raw = row.fm[c.key];
  if (Array.isArray(raw)) {
    const parts = raw.map((v) => valueToDisplay(v).trim()).filter((v) => v !== "");
    return parts.length ? parts : [""];
  }
  return [valueToDisplay(raw).trim()];
}

/** Is this filter doing anything? An all-defaults filter is dropped from config. */
export function isColFilterActive(f: ColumnFilter | undefined): boolean {
  if (!f) return false;
  if (f.values) return true;
  if (f.blanks === false) return true;
  const c = f.cond;
  if (!c) return false;
  return c.op === "empty" || c.op === "not-empty" || (c.value ?? "") !== "";
}

/** Does one row's column pass this filter? */
export function passesColFilter(values: string[], f: ColumnFilter): boolean {
  const empty = values.every((v) => v === "");
  if (f.values) {
    const allowed = new Set(f.values);
    if (empty) {
      if (!f.blanks) return false;
    } else if (!values.some((v) => v !== "" && allowed.has(v))) return false;
  } else if (empty && f.blanks === false) {
    return false;
  }
  const c = f.cond;
  if (c && (c.op === "empty" || c.op === "not-empty" || (c.value ?? "") !== "")) {
    if (c.op === "empty") return empty;
    if (c.op === "not-empty") return !empty;
    // Any element satisfying the condition keeps the row (list semantics).
    if (!values.some((v) => matchesText(v, c.op, c.value ?? ""))) return false;
  }
  return true;
}

const OPS: { id: Condition["op"]; label: string }[] = [
  { id: "contains", label: "contains" },
  { id: "=", label: "is" },
  { id: "!=", label: "is not" },
  { id: ">", label: ">" },
  { id: "<", label: "<" },
  { id: ">=", label: "≥" },
  { id: "<=", label: "≤" },
  { id: "empty", label: "is empty" },
  { id: "not-empty", label: "is not empty" },
];

export interface ColumnFilterOpts {
  app: App;
  anchor: HTMLElement;
  column: ColumnSpec;
  label: string;
  /** Distinct values available, already narrowed by the OTHER columns' filters. */
  distinct: { text: string; count: number }[];
  /** How many rows in that same set have an empty value here. */
  blankCount: number;
  current: ColumnFilter | undefined;
  /** Called on every change; `undefined` means "no filter on this column". */
  onChange: (f: ColumnFilter | undefined) => void;
  onSort: (dir: SortDir) => void;
}

/**
 * The dropdown itself. Lives in the anchor's own document so it works in popout
 * windows, and closes on outside click / Escape / scroll.
 */
export class ColumnFilterPopover {
  private el: HTMLElement;
  private doc: Document;
  private win: Window;
  private filter: ColumnFilter;
  private search = "";
  private listEl!: HTMLElement;
  private cleanup: (() => void)[] = [];

  constructor(private o: ColumnFilterOpts) {
    this.doc = o.anchor.ownerDocument;
    this.win = this.doc.defaultView ?? window;
    this.filter = JSON.parse(JSON.stringify(o.current ?? {})) as ColumnFilter;
    this.el = this.doc.body.createDiv({ cls: "gridsense-colfilter" });
    this.build();
    this.place();
    const onDown = (e: MouseEvent) => {
      if (!this.el.contains(e.target as Node) && !o.anchor.contains(e.target as Node)) this.close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    };
    // Capture phase: the grid's own handlers would otherwise swallow these.
    this.doc.addEventListener("mousedown", onDown, true);
    this.doc.addEventListener("keydown", onKey, true);
    this.win.addEventListener("resize", () => this.close());
    this.cleanup.push(() => this.doc.removeEventListener("mousedown", onDown, true));
    this.cleanup.push(() => this.doc.removeEventListener("keydown", onKey, true));
  }

  private place() {
    const r = this.o.anchor.getBoundingClientRect();
    const w = this.el.offsetWidth || 260;
    const h = this.el.offsetHeight || 380;
    const left = Math.max(8, Math.min(r.left, this.win.innerWidth - w - 8));
    const top = r.bottom + h > this.win.innerHeight - 8 ? Math.max(8, r.top - h) : r.bottom + 2;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  close() {
    for (const fn of this.cleanup) fn();
    this.el.remove();
  }

  /** Push the current state up, collapsing an all-defaults filter to undefined. */
  private emit() {
    const f: ColumnFilter = {};
    // Every value ticked (and blanks allowed) is not a filter — otherwise the
    // header would keep claiming the column is filtered after you re-check the
    // last box.
    if (
      this.filter.values &&
      this.filter.blanks !== false &&
      this.o.distinct.every((d) => this.filter.values?.includes(d.text))
    ) {
      delete this.filter.values;
      delete this.filter.blanks;
    }
    if (this.filter.values) f.values = this.filter.values;
    if (this.filter.blanks === false) f.blanks = false;
    else if (this.filter.values && this.filter.blanks) f.blanks = true;
    if (this.filter.cond) f.cond = this.filter.cond;
    this.o.onChange(isColFilterActive(f) ? f : undefined);
  }

  private build() {
    const head = this.el.createDiv({ cls: "gridsense-colfilter-head" });
    head.createSpan({ cls: "gridsense-colfilter-title", text: this.o.label });
    const clear = head.createSpan({ cls: "gridsense-colfilter-clear", text: "Clear" });
    clear.setAttr("title", "Remove this column's filter");
    clear.addEventListener("click", () => {
      this.filter = {};
      this.emit();
      this.close();
    });

    const sortRow = this.el.createDiv({ cls: "gridsense-colfilter-sort" });
    const mkSort = (dir: SortDir, text: string) => {
      const b = sortRow.createEl("button", { text });
      b.addEventListener("click", () => {
        this.o.onSort(dir);
        this.close();
      });
    };
    mkSort("asc", "Sort A→Z");
    mkSort("desc", "Sort Z→A");

    const searchWrap = this.el.createDiv({ cls: "gridsense-colfilter-search" });
    const search = searchWrap.createEl("input", {
      type: "text",
      attr: { placeholder: "Search values…" },
    });
    search.addEventListener("input", () => {
      this.search = search.value.trim().toLowerCase();
      this.renderList();
    });
    search.addEventListener("keydown", (e) => e.stopPropagation());

    this.listEl = this.el.createDiv({ cls: "gridsense-colfilter-list" });
    this.renderList();

    const condRow = this.el.createDiv({ cls: "gridsense-colfilter-cond" });
    const sel = condRow.createEl("select");
    sel.createEl("option", { value: "", text: "— condition —" });
    for (const op of OPS) sel.createEl("option", { value: op.id, text: op.label });
    sel.value = this.filter.cond?.op ?? "";
    const val = condRow.createEl("input", {
      type: "text",
      attr: { placeholder: "value" },
    });
    val.value = this.filter.cond?.value ?? "";
    const syncCond = () => {
      const op = sel.value as Condition["op"] | "";
      val.toggleClass("is-hidden", op === "" || op === "empty" || op === "not-empty");
      if (!op) delete this.filter.cond;
      else this.filter.cond = { op, value: val.value };
      this.emit();
    };
    sel.addEventListener("change", syncCond);
    val.addEventListener("keydown", (e) => e.stopPropagation());
    val.addEventListener("input", syncCond);
    syncCond();

    window.setTimeout(() => search.focus(), 0);
  }

  private renderList() {
    const list = this.listEl;
    list.empty();
    const shown = this.o.distinct.filter(
      (d) => !this.search || d.text.toLowerCase().includes(this.search)
    );
    const selected = this.filter.values ? new Set(this.filter.values) : null;
    const isOn = (text: string) => !selected || selected.has(text);

    const allRow = list.createDiv({ cls: "gridsense-colfilter-item is-all" });
    const allBox = allRow.createEl("input", { type: "checkbox" });
    allBox.checked = shown.every((d) => isOn(d.text)) && (!selected || this.filter.blanks !== false);
    allRow.createSpan({ text: this.search ? "(Select all matching)" : "(Select all)" });
    allRow.addEventListener("click", (e) => {
      if (e.target !== allBox) allBox.checked = !allBox.checked;
      if (allBox.checked && !this.search) {
        // Everything back on = no value restriction at all.
        delete this.filter.values;
        delete this.filter.blanks;
      } else {
        const base = new Set(selected ?? this.o.distinct.map((d) => d.text));
        for (const d of shown) {
          if (allBox.checked) base.add(d.text);
          else base.delete(d.text);
        }
        this.filter.values = [...base];
        if (!this.search) this.filter.blanks = allBox.checked;
      }
      this.emit();
      this.renderList();
    });

    const item = (text: string, count: number, blanks: boolean) => {
      const row = list.createDiv({ cls: "gridsense-colfilter-item" });
      const box = row.createEl("input", { type: "checkbox" });
      box.checked = blanks ? this.filter.blanks !== false : isOn(text);
      row.createSpan({ cls: "gridsense-colfilter-val", text: blanks ? "(Blanks)" : text });
      row.createSpan({ cls: "gridsense-colfilter-count", text: String(count) });
      row.addEventListener("click", (e) => {
        if (e.target !== box) box.checked = !box.checked;
        if (blanks) {
          this.filter.blanks = box.checked;
          // A blanks-only exclusion needs no value list.
          if (box.checked && !this.filter.values) delete this.filter.blanks;
        } else {
          // First deselection materialises the list from "everything".
          const base = new Set(selected ?? this.o.distinct.map((d) => d.text));
          if (box.checked) base.add(text);
          else base.delete(text);
          this.filter.values = [...base];
          if (this.filter.blanks === undefined) this.filter.blanks = true;
        }
        this.emit();
        this.renderList();
      });
    };

    if (this.o.blankCount && !this.search) item("", this.o.blankCount, true);
    for (const d of shown.slice(0, 500)) item(d.text, d.count, false);
    if (!shown.length) list.createDiv({ cls: "gridsense-colfilter-empty", text: "No values" });
    else if (shown.length > 500)
      list.createDiv({
        cls: "gridsense-colfilter-empty",
        text: `…${shown.length - 500} more — narrow with the search box`,
      });
  }
}

/** The funnel button that lives in a column header. */
export function makeFilterButton(th: HTMLElement, active: boolean): HTMLElement {
  const btn = th.createSpan({ cls: "gridsense-filter-btn" });
  if (active) btn.addClass("is-active");
  setIcon(btn, active ? "filter-x" : "filter");
  btn.setAttr("title", active ? "Filtered — click to change or clear" : "Filter this column");
  return btn;
}

export const colFilterKey = colId;
