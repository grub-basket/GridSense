import { Modal, Notice, TFile } from "obsidian";
import type { GridView } from "./grid-view";
import { ListSuggest } from "./formula-builder";

/**
 * "Add row" — a full-note-in-one-go form, for when the inline draft row at the
 * top/bottom of the grid is too cramped (many columns, or you want to see what
 * you're filling in). Fills the same code path as the draft row, so creation,
 * undo and history behave identically.
 */
export class AddRowModal extends Modal {
  private name = "";
  private values: Record<string, string> = {};
  private where: "top" | "bottom" = "bottom";
  private pathEl!: HTMLElement;
  private nameInput!: HTMLInputElement;

  constructor(
    private view: GridView,
    /** Seed values, e.g. copied from the selected row. */
    seed?: Record<string, string>
  ) {
    super(view.app);
    if (seed) this.values = { ...seed };
  }

  /** One label + control pair in the form grid. */
  private field(grid: HTMLElement, label: string): HTMLInputElement {
    grid.createDiv({ cls: "gridsense-addrow-label", text: label });
    const cell = grid.createDiv({ cls: "gridsense-addrow-control" });
    return cell.createEl("input", { type: "text" });
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("Add row");
    contentEl.addClass("gridsense-addrow");

    // Laid out as a single two-column grid rather than Obsidian Setting rows:
    // every label starts at the same x and every input is the same width, which
    // Setting can't promise (its label column sizes to the text).
    const grid = contentEl.createDiv({ cls: "gridsense-addrow-grid" });
    this.nameInput = this.field(grid, "Note name");
    this.nameInput.placeholder = "new note name…";
    this.nameInput.addEventListener("input", () => {
      this.name = this.nameInput.value;
      this.syncPath();
    });
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.submit(false);
      }
    });
    this.pathEl = grid.createDiv({ cls: "gridsense-addrow-path" });
    this.syncPath();

    const fields = this.view.propColumnFields();
    if (fields.length) {
      grid.createDiv({ cls: "gridsense-addrow-section", text: "Properties" });
      const scroller = grid.createDiv({ cls: "gridsense-addrow-fields" });
      const inner = scroller.createDiv({ cls: "gridsense-addrow-grid" });
      for (const { key, label } of fields) {
        const input = this.field(inner, label);
        input.value = this.values[key] ?? "";
        input.placeholder = "leave empty to skip";
        input.addEventListener("input", () => {
          this.values[key] = input.value;
        });
        new ListSuggest(this.app, input, () => this.view.distinctValues(key));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void this.submit(false);
          }
        });
      }
    } else {
      grid.createDiv({
        cls: "gridsense-addrow-path",
        text: "This grid has no property columns yet — the note is created empty, and you can add columns after.",
      });
    }

    grid.createDiv({ cls: "gridsense-addrow-label", text: "Position" });
    const posCell = grid.createDiv({ cls: "gridsense-addrow-control" });
    const pos = posCell.createEl("select", { cls: "dropdown" });
    pos.createEl("option", { value: "bottom", text: "Bottom of the grid" });
    pos.createEl("option", { value: "top", text: "Top of the grid" });
    pos.value = this.where;
    pos.addEventListener("change", () => {
      this.where = pos.value as "top" | "bottom";
    });

    const buttons = contentEl.createDiv({ cls: "gridsense-addrow-buttons" });
    const mk = (text: string, title: string, fn: () => void, cta = false) => {
      const b = buttons.createEl("button", { text, attr: { title } });
      if (cta) b.addClass("mod-cta");
      b.addEventListener("click", fn);
    };
    mk("Create", "Create the note and close", () => void this.submit(false), true);
    mk(
      "Create & add another",
      "Keeps the property values, clears the name — for typing several rows in a row",
      () => void this.submit(true)
    );
    mk("Cancel", "Close without creating anything", () => this.close());

    window.setTimeout(() => this.nameInput?.focus(), 0);
  }

  /** Live path + collision feedback, so Create never fails as a surprise. */
  private syncPath() {
    const name = this.name.trim().replace(/[\\/:]+/g, "-");
    if (!name) {
      this.pathEl.setText("Give the note a name to create it.");
      this.pathEl.removeClass("is-error");
      return;
    }
    const folder = this.view.scopeFolder();
    const path = `${folder ? folder + "/" : ""}${name}.md`;
    const taken = !!this.app.vault.getAbstractFileByPath(path);
    this.pathEl.setText(taken ? `"${path}" already exists — pick another name.` : path);
    this.pathEl.toggleClass("is-error", taken);
  }

  private async submit(again: boolean) {
    const file = await this.view.createRow(this.name, this.values, this.where);
    if (!(file instanceof TFile)) return; // createRow already explained why
    if (again) {
      this.name = "";
      this.nameInput.value = "";
      this.syncPath();
      this.nameInput.focus();
      new Notice(`GridSense: created "${file.basename}" — next one?`);
    } else {
      this.close();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
