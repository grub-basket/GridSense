import { App, Modal, Setting } from "obsidian";

/**
 * Cell zoom: a big textarea for editing one value comfortably (à la Bases
 * Toolbox). Used by the inline/modal property editor and the grid.
 */
export class ZoomValueModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private value: string,
    private onSave: (text: string) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("gridsense-zoom-modal");
    this.titleEl.setText(this.title);
    const ta = this.contentEl.createEl("textarea", { cls: "gridsense-zoom-text" });
    ta.value = this.value;
    window.setTimeout(() => {
      ta.focus();
      ta.select();
    }, 0);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.close();
        void this.onSave(ta.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
      e.stopPropagation();
    });
    new Setting(this.contentEl)
      .setDesc("⌘Enter saves · Esc cancels · lists: one item per line or comma-separated")
      .addButton((b) =>
        b
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            this.close();
            void this.onSave(ta.value);
          })
      );
  }
}
