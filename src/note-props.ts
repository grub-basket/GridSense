import { App, Modal, Notice, TFile } from "obsidian";
import { EditEngine, parseInput, valueToDisplay } from "./edits";
import { appendHistory } from "./history-log";

interface PropRow {
  key: string;
  value: unknown;
}

/**
 * Keyboard-first property editor for a single note. Arrow keys move between
 * rows, Tab toggles key/value cell, Enter edits, Cmd/Ctrl+Enter adds a row,
 * Cmd/Ctrl+Backspace deletes the property, Cmd/Ctrl+Z undoes, Esc closes.
 */
export class NotePropsModal extends Modal {
  private rows: PropRow[] = [];
  private sel = 0;
  private cell: "key" | "value" = "value";
  private editing = false;
  private engine: EditEngine;
  private listEl: HTMLElement | null = null;

  constructor(app: App, private file: TFile) {
    super(app);
    // Property-modal edits log to the note's parent-folder grid scope.
    this.engine = new EditEngine(app, (entry) =>
      void appendHistory(app, file.parent?.path === "/" ? "" : file.parent?.path ?? "", entry)
    );
  }

  onOpen() {
    this.modalEl.addClass("gridsense-props-modal");
    this.titleEl.setText(`Properties — ${this.file.basename}`);
    this.load();
    this.scope.register([], "ArrowDown", (e) => this.nav(e, 1));
    this.scope.register([], "ArrowUp", (e) => this.nav(e, -1));
    this.scope.register([], "Tab", (e) => {
      if (this.editing) return;
      e.preventDefault();
      this.cell = this.cell === "key" ? "value" : "key";
      this.paint();
    });
    this.scope.register([], "Enter", (e) => {
      if (this.editing) return;
      e.preventDefault();
      this.beginEdit();
    });
    this.scope.register(["Mod"], "Enter", (e) => {
      e.preventDefault();
      this.addRow();
    });
    this.scope.register(["Mod"], "Backspace", (e) => {
      if (this.editing) return;
      e.preventDefault();
      void this.deleteRow();
    });
    this.scope.register(["Mod"], "z", (e) => {
      if (this.editing) return;
      e.preventDefault();
      void this.engine.undo().then(() => this.load());
    });
    this.contentEl.createDiv({
      cls: "gridsense-props-hint",
      text: "↑↓ move · Tab key/value · Enter edit · ⌘Enter add · ⌘⌫ delete · ⌘Z undo",
    });
  }

  private load() {
    const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter ?? {};
    this.rows = Object.entries(fm)
      .filter(([k]) => k !== "position")
      .map(([key, value]) => ({ key, value }));
    this.sel = Math.min(this.sel, Math.max(0, this.rows.length - 1));
    this.paint();
  }

  private paint() {
    if (!this.listEl) this.listEl = this.contentEl.createDiv({ cls: "gridsense-props-list" });
    const list = this.listEl;
    list.empty();
    if (!this.rows.length)
      list.createDiv({ cls: "gridsense-props-empty", text: "No properties. ⌘Enter to add one." });
    this.rows.forEach((row, i) => {
      const rowEl = list.createDiv({ cls: "gridsense-props-row" });
      const keyEl = rowEl.createDiv({ cls: "gridsense-props-key", text: row.key });
      const valEl = rowEl.createDiv({ cls: "gridsense-props-value", text: valueToDisplay(row.value) });
      if (i === this.sel)
        (this.cell === "key" ? keyEl : valEl).addClass("gridsense-props-selected");
      keyEl.addEventListener("click", () => {
        this.sel = i;
        this.cell = "key";
        this.paint();
      });
      keyEl.addEventListener("dblclick", () => this.beginEdit());
      valEl.addEventListener("click", () => {
        this.sel = i;
        this.cell = "value";
        this.paint();
      });
      valEl.addEventListener("dblclick", () => this.beginEdit());
    });
  }

  private nav(e: KeyboardEvent, d: number) {
    if (this.editing) return;
    e.preventDefault();
    this.sel = Math.max(0, Math.min(this.rows.length - 1, this.sel + d));
    this.paint();
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
      if (!commit || text === original) return this.paint();
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
    if (!newKey || newKey === row.key) return this.paint();
    if (["__proto__", "constructor", "prototype"].includes(newKey)) {
      new Notice("GridSense: unsafe property name");
      return this.paint();
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

  private async deleteRow() {
    const row = this.rows[this.sel];
    if (!row) return;
    await this.engine.apply(`delete ${row.key}`, [{ file: this.file, key: row.key, value: null }]);
    new Notice(`GridSense: deleted "${row.key}" (⌘Z to undo while open)`);
    this.load();
  }
}
