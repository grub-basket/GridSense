import { App, Menu, Notice, TFile, setIcon } from "obsidian";
import { EditEngine, valueToDisplay } from "./edits";
import { ZoomValueModal } from "./zoom";

interface PropRow {
  key: string;
  value: unknown;
}

const UNSAFE_KEYS = ["__proto__", "constructor", "prototype"];

/** Obsidian's reserved frontmatter properties: fixed widgets, always lists. */
const RESERVED: Record<string, string> = {
  aliases: "aliases",
  tags: "tags",
  cssclasses: "multitext",
};

const TYPE_CHOICES: { widget: string; label: string; icon: string }[] = [
  { widget: "text", label: "Text", icon: "text" },
  { widget: "multitext", label: "List", icon: "list" },
  { widget: "number", label: "Number", icon: "hash" },
  { widget: "checkbox", label: "Checkbox", icon: "check-square" },
  { widget: "date", label: "Date", icon: "calendar" },
  { widget: "datetime", label: "Date & time", icon: "clock" },
];

function iconForWidget(widget: string | null): string {
  switch (widget) {
    case "aliases":
      return "forward";
    case "tags":
      return "tags";
    case "multitext":
      return "list";
    case "number":
      return "hash";
    case "checkbox":
      return "check-square";
    case "date":
      return "calendar";
    case "datetime":
      return "clock";
    default:
      return "text";
  }
}

const LIST_WIDGETS = new Set(["multitext", "tags", "aliases"]);

/**
 * Reusable keyboard-friendly property editor for one note. Renders into any
 * container — the NotePropsModal wraps it, and the inline takeover mounts it
 * inside the editor where Obsidian's native properties panel normally sits.
 * Type-aware: reserved properties (tags/aliases/cssclasses) and assigned
 * property types shape parsing, icons, and the per-row type menu.
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
        text: "↑↓ rows · ←→/Tab key↔value · Enter edit · ⌘Enter add · ⌘⌫ delete · ⌘Z undo",
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

  // ------------------------------------------------------------------- types

  /** Effective widget for a key: reserved beats vault-assigned type. */
  private widgetFor(key: string): string | null {
    const reserved = RESERVED[key.toLowerCase()];
    if (reserved) return reserved;
    try {
      const mtm = (
        this.app as unknown as {
          metadataTypeManager?: { getPropertyInfo?: (k: string) => { widget?: string } | null };
        }
      ).metadataTypeManager;
      return mtm?.getPropertyInfo?.(key.toLowerCase())?.widget ?? null;
    } catch {
      return null;
    }
  }

  private isReserved(key: string): boolean {
    return key.toLowerCase() in RESERVED;
  }

  /** Parse typed text according to the property's effective widget. */
  private parseByType(key: string, text: string, previous: unknown): unknown {
    const t = text.trim();
    if (t === "") return null;
    const widget = this.widgetFor(key);
    if (widget && LIST_WIDGETS.has(widget)) {
      let items = /\n/.test(text)
        ? text.split("\n")
        : text.split(",");
      items = items.map((s) => s.trim()).filter((s) => s !== "");
      if (widget === "tags") items = items.map((s) => s.replace(/^#/, ""));
      return items;
    }
    if (widget === "number") {
      const n = Number(t);
      if (!Number.isNaN(n)) return n;
      new Notice(`GridSense: "${t}" isn't a number — saved as typed`);
      return t;
    }
    if (widget === "checkbox") {
      if (/^(true|yes|1|x|✓)$/i.test(t)) return true;
      if (/^(false|no|0|-)$/i.test(t)) return false;
      return Boolean(t);
    }
    // date/datetime/text: keep the string; fall back to shape-of-previous for
    // untyped properties (lists stay lists, numbers stay numbers).
    if (!widget && Array.isArray(previous))
      return t.split(",").map((s) => s.trim()).filter(Boolean);
    if (!widget && typeof previous === "number" && !Number.isNaN(Number(t))) return Number(t);
    if (!widget && typeof previous === "boolean") return /^(true|yes|1)$/i.test(t);
    return t;
  }

  private setType(key: string, widget: string) {
    try {
      (
        this.app as unknown as {
          metadataTypeManager: { setType: (k: string, w: string) => void };
        }
      ).metadataTypeManager.setType(key.toLowerCase(), widget);
      new Notice(`GridSense: "${key}" is now ${widget}`);
      this.paint();
    } catch (e) {
      new Notice(`GridSense: couldn't set type (${String(e)})`);
    }
  }

  // ------------------------------------------------------------------- paint

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

      // Left-side type/menu button (mirrors Obsidian's property icon).
      const iconBtn = rowEl.createDiv({ cls: "gridsense-props-type" });
      setIcon(iconBtn, iconForWidget(this.widgetFor(row.key)));
      iconBtn.setAttr(
        "title",
        this.isReserved(row.key)
          ? `Reserved property (${this.widgetFor(row.key)}) — click for options`
          : "Property options: type, zoom, delete"
      );
      iconBtn.addEventListener("click", (e) => this.openRowMenu(e, i));

      const keyEl = rowEl.createDiv({ cls: "gridsense-props-key", text: row.key });
      const valEl = rowEl.createDiv({ cls: "gridsense-props-value" });
      this.paintValue(valEl, row);
      if (i === this.sel)
        (this.cell === "key" ? keyEl : valEl).addClass("gridsense-props-selected");

      // Single handler for select + double-click-to-edit: repainting between
      // the two clicks of a dblclick used to destroy the target and kick the
      // new input's blur — so only repaint when the selection actually moves,
      // and use e.detail to catch the second click.
      const pick = (cell: "key" | "value") => (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest(".gridsense-chip-x")) return;
        const moved = this.sel !== i || this.cell !== cell;
        this.sel = i;
        this.cell = cell;
        if (moved) this.paint();
        if (e.detail >= 2) this.beginEdit();
        else this.container.focus();
      };
      keyEl.addEventListener("click", pick("key"));
      valEl.addEventListener("click", pick("value"));

      const del = rowEl.createDiv({ cls: "gridsense-props-del", text: "×" });
      del.setAttr("title", `Delete "${row.key}" (undoable)`);
      del.addEventListener("click", () => void this.deleteRowAt(i));
    });
    const add = this.listEl!.createDiv({ cls: "gridsense-props-add" });
    const addIcon = add.createSpan();
    setIcon(addIcon, "plus");
    add.createSpan({ text: " Add property" });
    add.addEventListener("click", () => this.addRow());
  }

  /** Lists render as always-visible chips with an × per item. */
  private paintValue(valEl: HTMLElement, row: PropRow) {
    if (Array.isArray(row.value)) {
      const wrap = valEl.createDiv({ cls: "gridsense-chips" });
      row.value.forEach((item, idx) => {
        const chip = wrap.createSpan({ cls: "gridsense-chip" });
        chip.createSpan({ text: valueToDisplay(item) });
        const x = chip.createSpan({ cls: "gridsense-chip-x", text: "×" });
        x.setAttr("title", "Remove item (undoable)");
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.removeListItem(row, idx);
        });
      });
      if (!row.value.length) wrap.createSpan({ cls: "gridsense-chips-empty", text: "(empty list)" });
      return;
    }
    valEl.setText(valueToDisplay(row.value));
  }

  private openRowMenu(e: MouseEvent, i: number) {
    const row = this.rows[i];
    if (!row) return;
    this.sel = i;
    this.paint();
    const menu = new Menu();
    if (this.isReserved(row.key)) {
      menu.addItem((m) =>
        m.setTitle(`Reserved property — always a ${this.widgetFor(row.key)} list`).setDisabled(true)
      );
    } else {
      const current = this.widgetFor(row.key);
      for (const t of TYPE_CHOICES) {
        menu.addItem((m) =>
          m
            .setTitle(`Type: ${t.label}${current === t.widget ? " ✓" : ""}`)
            .setIcon(t.icon)
            .onClick(() => this.setType(row.key, t.widget))
        );
      }
    }
    menu.addSeparator();
    menu.addItem((m) =>
      m.setTitle("Zoom value…").setIcon("maximize-2").onClick(() => this.zoomRow(i))
    );
    menu.addItem((m) =>
      m.setTitle(`Delete "${row.key}"`).setIcon("trash").onClick(() => void this.deleteRowAt(i))
    );
    menu.showAtMouseEvent(e);
  }

  private zoomRow(i: number) {
    const row = this.rows[i];
    if (!row) return;
    const current = Array.isArray(row.value)
      ? row.value.map((v) => valueToDisplay(v)).join("\n")
      : valueToDisplay(row.value);
    new ZoomValueModal(this.app, `${row.key} — ${this.file.basename}`, current, async (text) => {
      await this.setValue(row, text);
    }).open();
  }

  // ---------------------------------------------------------------- keyboard

  private onKeyDown(e: KeyboardEvent) {
    if (this.editing) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowDown" && !mod) {
      e.preventDefault();
      this.sel = Math.min(this.rows.length - 1, this.sel + 1);
      this.paint();
    } else if (e.key === "ArrowUp" && !mod) {
      e.preventDefault();
      this.sel = Math.max(0, this.sel - 1);
      this.paint();
    } else if (e.key === "ArrowLeft" && !mod) {
      e.preventDefault();
      this.cell = "key";
      this.paint();
    } else if (e.key === "ArrowRight" && !mod) {
      e.preventDefault();
      this.cell = "value";
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

  // ----------------------------------------------------------------- editing

  private selectedEl(): HTMLElement | null {
    return this.listEl?.querySelector(".gridsense-props-selected") ?? null;
  }

  private beginEdit() {
    const row = this.rows[this.sel];
    const el = this.selectedEl();
    if (!row || !el) return;
    this.editing = true;
    const original =
      this.cell === "key"
        ? row.key
        : Array.isArray(row.value)
          ? row.value.map((v) => valueToDisplay(v)).join(", ")
          : valueToDisplay(row.value);
    el.empty();
    const input = el.createEl("input", { cls: "gridsense-editor", type: "text" });
    input.value = original;
    input.focus();
    input.select();
    const finish = (commit: boolean) => {
      if (!this.editing) return;
      this.editing = false;
      const text = input.value.trim();
      const done = () => {
        this.load();
        // Keep keyboard flow inside the strip: without this, the next Tab
        // jumps into the note body.
        this.container.focus();
      };
      if (!commit || text === original) return done();
      if (this.cell === "key") void this.renameKey(row, text).then(done);
      else void this.setValue(row, input.value).then(done);
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

  // ------------------------------------------------------------------ writes

  private async setValue(row: PropRow, text: string) {
    const value = this.parseByType(row.key, text, row.value);
    row.value = value;
    await this.engine.apply(`edit ${row.key}`, [{ file: this.file, key: row.key, value }]);
    this.load();
  }

  private async removeListItem(row: PropRow, idx: number) {
    if (!Array.isArray(row.value)) return;
    const next = row.value.filter((_, i) => i !== idx);
    row.value = next;
    await this.engine.apply(`remove item from ${row.key}`, [
      { file: this.file, key: row.key, value: next.length ? next : null },
    ]);
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
