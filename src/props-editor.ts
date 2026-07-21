import { App, Notice, TFile } from "obsidian";
import { EditEngine, parseInput, valueToDisplay } from "./edits";

interface PropRow {
  key: string;
  value: unknown;
}

const UNSAFE_KEYS = ["__proto__", "constructor", "prototype"];

/**
 * Reusable keyboard-friendly property editor for one note. Renders into any
 * container — the NotePropsModal wraps it, and the inline takeover mounts it
 * inside the editor where Obsidian's native properties panel normally sits.
 */
export class PropsEditor {
  private rows: PropRow[] = [];
  private sel = 0;
  private cell: "key" | "value" = "value";
  editing = false;
  private listEl: HTMLElement | null = null;

  constructor(
    private app: App,
    private file: TFile,
    private container: HTMLElement,
    private engine: EditEngine,
    private opts: { hint?: boolean } = {}
  ) {}

  mount() {
    this.container.addClass("gridsense-props-host");
    if (this.opts.hint)
      this.container.createDiv({
        cls: "gridsense-props-hint",
        text: "↑↓ move · Tab key/value · Enter edit · ⌘Enter add · ⌘⌫ delete · ⌘Z undo",
      });
    this.listEl = this.container.createDiv({ cls: "gridsense-props-list" });
    this.container.tabIndex = 0;
    this.container.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.load();
  }

  setFile(file: TFile) {
    this.file = file;
    this.load();
  }

  /** Re-read frontmatter and repaint (no-op while an editor is open). */
  load() {
    if (this.editing) return;
    const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter ?? {};
    this.rows = Object.entries(fm)
      .filter(([k]) => k !== "position")
      .map(([key, value]) => ({ key, value }));
    this.sel = Math.min(this.sel, Math.max(0, this.rows.length - 1));
    this.paint();
  }

  private paint() {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    if (!this.rows.length) {
      const empty = list.createDiv({
        cls: "gridsense-props-empty",
        text: "No properties — click to add one",
      });
      empty.addEventListener("click", () => this.addRow());
      return;
    }
    this.rows.forEach((row, i) => {
      const rowEl = list.createDiv({ cls: "gridsense-props-row" });
      const keyEl = rowEl.createDiv({ cls: "gridsense-props-key", text: row.key });
      const valEl = rowEl.createDiv({
        cls: "gridsense-props-value",
        text: valueToDisplay(row.value),
      });
      if (i === this.sel)
        (this.cell === "key" ? keyEl : valEl).addClass("gridsense-props-selected");
      keyEl.addEventListener("click", () => {
        this.sel = i;
        this.cell = "key";
        this.paint();
        this.container.focus();
      });
      keyEl.addEventListener("dblclick", () => this.beginEdit());
      valEl.addEventListener("click", () => {
        this.sel = i;
        this.cell = "value";
        this.paint();
        this.container.focus();
      });
      valEl.addEventListener("dblclick", () => this.beginEdit());
      const del = rowEl.createDiv({ cls: "gridsense-props-del", text: "×" });
      del.setAttr("title", `Delete "${row.key}" (undoable)`);
      del.addEventListener("click", () => void this.deleteRowAt(i));
    });
    const add = list.createDiv({ cls: "gridsense-props-add", text: "＋ property" });
    add.addEventListener("click", () => this.addRow());
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.editing) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT") return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowDown" && !mod) {
      e.preventDefault();
      this.sel = Math.min(this.rows.length - 1, this.sel + 1);
      this.paint();
    } else if (e.key === "ArrowUp" && !mod) {
      e.preventDefault();
      this.sel = Math.max(0, this.sel - 1);
      this.paint();
    } else if (e.key === "Tab") {
      e.preventDefault();
      this.cell = this.cell === "key" ? "value" : "key";
      this.paint();
    } else if (e.key === "Enter" && mod) {
      e.preventDefault();
      this.addRow();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.beginEdit();
    } else if (e.key === "Backspace" && mod) {
      e.preventDefault();
      void this.deleteRowAt(this.sel);
    } else if ((e.key === "z" || e.key === "Z") && mod && !e.shiftKey) {
      e.preventDefault();
      void this.engine.undo().then(() => this.load());
    } else if (((e.key === "z" || e.key === "Z") && mod && e.shiftKey) || (e.key === "y" && mod)) {
      e.preventDefault();
      void this.engine.redo().then(() => this.load());
    }
  }

  private selectedEl(): HTMLElement | null {
    return this.listEl?.querySelector(".gridsense-props-selected") ?? null;
  }

  private beginEdit() {
    const row = this.rows[this.sel];
    const el = this.selectedEl();
    if (!row || !el) return;
    this.editing = true;
    const original = this.cell === "key" ? row.key : valueToDisplay(row.value);
    el.empty();
    const input = el.createEl("input", { cls: "gridsense-editor", type: "text" });
    input.value = original;
    input.focus();
    input.select();
    const finish = (commit: boolean) => {
      if (!this.editing) return;
      this.editing = false;
      const text = input.value.trim();
      if (!commit || text === original) return this.load();
      if (this.cell === "key") void this.renameKey(row, text);
      else void this.setValue(row, input.value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }

  private async setValue(row: PropRow, text: string) {
    const value = parseInput(text, row.value);
    row.value = value;
    await this.engine.apply(`edit ${row.key}`, [{ file: this.file, key: row.key, value }]);
    this.load();
  }

  private async renameKey(row: PropRow, newKey: string) {
    if (!newKey || newKey === row.key) return this.load();
    if (UNSAFE_KEYS.includes(newKey)) {
      new Notice("GridSense: unsafe property name");
      return this.load();
    }
    const value = row.value;
    await this.engine.apply(`rename ${row.key} → ${newKey}`, [
      { file: this.file, key: row.key, value: null },
      { file: this.file, key: newKey, value: value ?? "" },
    ]);
    this.load();
  }

  private addRow() {
    if (this.editing) return;
    this.rows.push({ key: "", value: "" });
    this.sel = this.rows.length - 1;
    this.cell = "key";
    this.paint();
    this.beginEdit();
  }

  private async deleteRowAt(i: number) {
    const row = this.rows[i];
    if (!row || !row.key) return;
    await this.engine.apply(`delete ${row.key}`, [{ file: this.file, key: row.key, value: null }]);
    new Notice(`GridSense: deleted "${row.key}" (⌘Z to undo)`);
    this.load();
  }
}
