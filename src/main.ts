import { FuzzySuggestModal, Plugin, TFolder } from "obsidian";
import { GRID_VIEW_TYPE, GridView } from "./grid-view";
import { NotePropsModal } from "./note-props";
import { DEFAULT_SETTINGS, FolderConfig, GridSenseSettings } from "./types";

export default class GridSensePlugin extends Plugin {
  settings: GridSenseSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.registerView(GRID_VIEW_TYPE, (leaf) => new GridView(leaf, this));

    this.addCommand({
      id: "open-grid-for-folder",
      name: "Open grid for folder…",
      callback: () => new FolderPickModal(this).open(),
    });

    this.addCommand({
      id: "edit-note-properties",
      name: "Edit properties of current note (keyboard grid)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) new NotePropsModal(this.app, file).open();
        return true;
      },
    });

    this.addRibbonIcon("table", "GridSense: open grid for folder", () =>
      new FolderPickModal(this).open()
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setTitle("Open in GridSense")
            .setIcon("table")
            .onClick(() => void this.openGrid(file.path))
        );
      })
    );
  }

  async openGrid(folder: string) {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: GRID_VIEW_TYPE, state: { folder }, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  folderConfig(folder: string): FolderConfig {
    let cfg = this.settings.folders[folder];
    if (!cfg) {
      cfg = { headingColumns: [], hidden: [] };
      this.settings.folders[folder] = cfg;
    }
    return cfg;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class FolderPickModal extends FuzzySuggestModal<TFolder> {
  constructor(private plugin: GridSensePlugin) {
    super(plugin.app);
    this.setPlaceholder("Pick a folder to open as a grid…");
  }

  getItems(): TFolder[] {
    const out: TFolder[] = [];
    const walk = (f: TFolder) => {
      out.push(f);
      for (const c of f.children) if (c instanceof TFolder) walk(c);
    };
    walk(this.plugin.app.vault.getRoot());
    return out;
  }

  getItemText(f: TFolder): string {
    return f.path === "/" ? "(vault root)" : f.path;
  }

  onChooseItem(f: TFolder): void {
    void this.plugin.openGrid(f.path === "/" ? "" : f.path);
  }
}
