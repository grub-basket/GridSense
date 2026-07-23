import { App, Modal, TFile } from "obsidian";
import { EditEngine } from "./edits";
import { PropsEditor } from "./props-editor";
import { appendHistory } from "./history-log";

import type GridSensePlugin from "./main";

/** Modal wrapper around the shared PropsEditor component. */
export class NotePropsModal extends Modal {
  private editor: PropsEditor;

  constructor(app: App, file: TFile, plugin?: GridSensePlugin) {
    super(app);
    const engine = new EditEngine(app, (entry) =>
      void appendHistory(app, file.parent?.path === "/" ? "" : file.parent?.path ?? "", entry)
    );
    this.editor = new PropsEditor(app, file, this.contentEl, engine, { hint: true, plugin });
    this.titleEl.setText(`Properties — ${file.basename}`);
    this.modalEl.addClass("gridsense-props-modal");
  }

  onOpen() {
    this.editor.mount();
    this.contentEl.focus();
  }
}
