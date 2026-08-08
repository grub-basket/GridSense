import { Modal, Notice, Setting, TFile } from "obsidian";
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

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("Add row");
    contentEl.addClass("gridsense-addrow");

    new Setting(contentEl)
      .setName("Note name")
      .setDesc("The file this row becomes. Required.")
      .addText((t) => {
        this.nameInput = t.inputEl;
        t.setPlaceholder("new note name…").onChange((v) => {
          this.name = v;
          this.syncPath();
        });
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void this.submit(false);
          }
        });
      });
    this.pathEl = contentEl.createDiv({ cls: "gridsense-addrow-path" });
    this.syncPath();

    const fields = this.view.propColumnFields();
    if (fields.length) {
      contentEl.createEl("h4", { text: "Properties" });
      const wrap = contentEl.createDiv({ cls: "gridsense-addrow-fields" });
      for (const { key, label } of fields) {
        new Setting(wrap).setName(label).addText((t) => {
          t.setValue(this.values[key] ?? "")
            .setPlaceholder("leave empty to skip")
            .onChange((v) => {
              this.values[key] = v;
            });
          new ListSuggest(this.app, t.inputEl, () => this.view.distinctValues(key));
          t.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void this.submit(false);
            }
          });
        });
      }
    } else {
      contentEl.createDiv({
        cls: "gridsense-addrow-path",
        text: "This grid has no property columns yet — the note is created empty, and you can add columns after.",
      });
    }

    new Setting(contentEl)
      .setName("Position")
      .setDesc("Where the new row is pinned until the next recompile.")
      .addDropdown((d) =>
        d
          .addOptions({ bottom: "Bottom of the grid", top: "Top of the grid" })
          .setValue(this.where)
          .onChange((v) => {
            this.where = v as "top" | "bottom";
          })
      );

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Create")
          .setCta()
          .onClick(() => void this.submit(false))
      )
      .addButton((b) =>
        b
          .setButtonText("Create & add another")
          .setTooltip("Keeps the property values, clears the name — for typing several rows in a row")
          .onClick(() => void this.submit(true))
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));

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
