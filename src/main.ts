import { FuzzySuggestModal, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import { GRID_VIEW_TYPE, GridView } from "./grid-view";
import { NotePropsModal } from "./note-props";
import { InlinePropsManager } from "./inline-props";
import { DEFAULT_SETTINGS, FolderConfig, GridSenseSettings } from "./types";

export default class GridSensePlugin extends Plugin {
  settings: GridSenseSettings = DEFAULT_SETTINGS;
  inlineProps: InlinePropsManager | null = null;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new GridSenseSettingTab(this));
    this.inlineProps = new InlinePropsManager(this.app, this);
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.inlineProps) this.inlineProps?.enable();
    });
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

  onunload() {
    this.inlineProps?.disable();
  }
}

class GridSenseSettingTab extends PluginSettingTab {
  constructor(private plugin: GridSensePlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Replace Obsidian's properties panel (beta)")
      .setDesc(
        "Hide the native frontmatter render in notes and show GridSense's keyboard-friendly property editor in its place (Live Preview and Reading mode). Off by default while in beta."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.inlineProps).onChange(async (v) => {
          this.plugin.settings.inlineProps = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.inlineProps?.enable();
          else this.plugin.inlineProps?.disable();
        })
      );
    new Setting(this.containerEl)
      .setName("Default row limit")
      .setDesc(
        "Applied to any grid without its own row limit (set per folder in ▦ columns & views). 0 = unlimited. The grid's row counter always shows when a limit is trimming rows."
      )
      .addText((t) => {
        t.setPlaceholder("0");
        t.setValue(String(this.plugin.settings.defaultRowLimit || 0));
        t.onChange(async (v) => {
          const n = parseInt(v);
          if (!Number.isNaN(n) && n >= 0) {
            this.plugin.settings.defaultRowLimit = n;
            await this.plugin.saveSettings();
          }
        });
      });
    new Setting(this.containerEl)
      .setName("Show heading names in heading columns")
      .setDesc(
        "Heading-embed cells start with the heading itself (as a link into the note). Turn off to show just the section content with a small ↳ link."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showHeadingNames).onChange(async (v) => {
          this.plugin.settings.showHeadingNames = v;
          await this.plugin.saveSettings();
        })
      );
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
