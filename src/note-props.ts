import { App, Modal, TFile } from "obsidian";
import { EditEngine } from "./edits";
import { PropsEditor } from "./props-editor";
import { appendHistory } from "./history-log";

/** Modal wrapper around the shared PropsEditor component. */
export class NotePropsModal extends Modal {
  private editor: PropsEditor;

  constructor(app: App, file: TFile) {
    super(app);
    const engine = new EditEngine(app, (entry) =>
      void appendHistory(app, file.parent?.path === "/" ? "" : file.parent?.path ?? "", entry)
    );
    this.editor = new PropsEditor(app, file, this.contentEl, engine, { hint: true });
    this.titleEl.setText(`Properties — ${file.basename}`);
    this.modalEl.addClass("gridsense-props-modal");
  }

  onOpen() {
    this.editor.mount();
    this.contentEl.focus();
  }
}
