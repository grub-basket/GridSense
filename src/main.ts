import { FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import { GRID_VIEW_TYPE, GridView } from "./grid-view";
import { NotePropsModal } from "./note-props";
import { InlinePropsManager } from "./inline-props";
import { DEFAULT_SETTINGS, FolderConfig, GridSenseSettings } from "./types";
import { ConfigFileStore } from "./config-file";
import { GridTrash } from "./trash";
import { ConfirmModal } from "./formula-builder";

export default class GridSensePlugin extends Plugin {
  settings: GridSenseSettings = DEFAULT_SETTINGS;
  inlineProps: InlinePropsManager | null = null;
  configFile: ConfigFileStore | null = null;
  trash: GridTrash | null = null;

  async onload() {
    await this.loadSettings();
    this.trash = new GridTrash(this.app, this);
    this.configFile = new ConfigFileStore(this.app, this);
    this.configFile.register();
    // Vault-side config wins on load: it's the copy that travels with notes.
    this.app.workspace.onLayoutReady(() => {
      void this.configFile?.load().then((loaded) => {
        if (loaded) this.refreshOpenGrids();
      });
    });

    this.addSettingTab(new GridSenseSettingTab(this));
    this.inlineProps = new InlinePropsManager(this.app, this);
    // Always start: the manager either takes over the panel or just offers the
    // "GridSense properties" switch button above Obsidian's own.
    this.app.workspace.onLayoutReady(() => this.inlineProps?.start());
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
        if (!checking) new NotePropsModal(this.app, file, this).open();
        return true;
      },
    });

    this.addCommand({
      id: "empty-gridsense-trash",
      name: "Empty GridSense trash (move to Obsidian trash)",
      callback: () => {
        const files = this.trash?.list() ?? [];
        if (!files.length) {
          new Notice("GridSense: the GridSense trash is empty");
          return;
        }
        new ConfirmModal(
          this.app,
          `Empty GridSense trash (${files.length} note${files.length === 1 ? "" : "s"})?`,
          `Everything in "${this.trash?.folderPath()}" is handed to Obsidian's trash, following your "Deleted files" setting. GridSense's undo can no longer bring these back.`,
          "Empty trash",
          async () => {
            const n = (await this.trash?.empty()) ?? 0;
            new Notice(`GridSense: emptied ${n} note${n === 1 ? "" : "s"} into Obsidian's trash`);
          }
        ).open();
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
    this.configFile?.save();
  }

  /** Repaint every open grid (config changed underneath them). */
  refreshOpenGrids() {
    for (const leaf of this.app.workspace.getLeavesOfType(GRID_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof GridView) void view.refresh();
    }
  }

  onunload() {
    this.inlineProps?.stop();
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
          this.plugin.inlineProps?.apply();
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
    this.containerEl.createEl("div", { cls: "setting-item-heading", text: "Sync" });
    new Setting(this.containerEl)
      .setName("Store grid config in the vault")
      .setDesc(
        "Per-grid setup (columns, widths, sort, filters, views, formulas) is normally kept in the plugin's data.json, which only travels if you sync your .obsidian folder. Turn this on to mirror it into a vault file that syncs with your notes; external updates are picked up automatically."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncConfigFile).onChange(async (v) => {
          this.plugin.settings.syncConfigFile = v;
          await this.plugin.saveSettings();
          if (v) {
            await this.plugin.configFile?.saveNow();
            new Notice(`GridSense: grid config now stored at ${this.plugin.configFile?.path()}`);
          }
          this.display();
        })
      );
    if (this.plugin.settings.syncConfigFile)
      new Setting(this.containerEl)
        .setName("Config file path")
        .setDesc("Vault-relative. Keep the .json extension; make sure your sync includes this file type.")
        .addText((t) => {
          t.setPlaceholder("gridsense-config.json");
          t.setValue(this.plugin.settings.configFilePath);
          t.onChange(async (v) => {
            this.plugin.settings.configFilePath = v.trim() || "gridsense-config.json";
            await this.plugin.saveSettings();
          });
          t.inputEl.addEventListener("blur", () => void this.plugin.configFile?.saveNow());
        });

    this.containerEl.createEl("div", { cls: "setting-item-heading", text: "Notes & grids" });
    new Setting(this.containerEl)
      .setName("GridSense trash folder")
      .setDesc(
        "Deleting a row moves the note here instead of straight to Obsidian's trash, so it stays undoable and browsable. Empty it with the \"Empty GridSense trash\" command."
      )
      .addText((t) => {
        t.setPlaceholder("GridSense Trash");
        t.setValue(this.plugin.settings.trashFolder);
        t.onChange(async (v) => {
          this.plugin.settings.trashFolder = v.trim() || "GridSense Trash";
          await this.plugin.saveSettings();
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
