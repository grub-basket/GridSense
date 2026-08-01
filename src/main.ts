import { FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import { GRID_VIEW_TYPE, GridView } from "./grid-view";
import { NotePropsModal } from "./note-props";
import { InlinePropsManager } from "./inline-props";
import { DEFAULT_SETTINGS, FolderConfig, GridSenseSettings } from "./types";
import { ConfigFileStore } from "./config-file";
import { GridTrash } from "./trash";
import { PasteImportModal } from "./import";
import { DiagnoseModal } from "./diagnose";
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
    // .grid files: saved grid views, opened like any other document.
    this.registerExtensions(["grid"], GRID_VIEW_TYPE);

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

    // Grid actions as commands so they can take user hotkeys.
    const gridCmd = (id: string, name: string, fn: (v: GridView) => void) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(GridView);
          if (!view) return false;
          if (!checking) fn(view);
          return true;
        },
      });
    gridCmd("grid-fill-down", "Grid: fill down", (v) => v.commandFill("down"));
    gridCmd("grid-fill-right", "Grid: fill right", (v) => v.commandFill("right"));
    gridCmd("grid-find-replace", "Grid: find & replace…", (v) => v.commandFindReplace());
    gridCmd("grid-undo", "Grid: undo", (v) => v.commandUndo());
    gridCmd("grid-redo", "Grid: redo", (v) => v.commandRedo());
    gridCmd("grid-toggle-wrap", "Grid: toggle word wrap", (v) => v.commandToggleWrap());
    gridCmd("grid-add-column", "Grid: add column…", (v) => v.commandAddColumn());
    gridCmd("grid-columns", "Grid: columns & views…", (v) => v.commandColumns());
    gridCmd("grid-filters", "Grid: filters…", (v) => v.commandFilters());
    gridCmd("grid-jump-column", "Grid: jump to column…", (v) => v.commandJumpToColumn());
    gridCmd("grid-history", "Grid: edit history…", (v) => void v.commandHistory());
    gridCmd("grid-recompile", "Grid: recompile from notes", (v) => v.commandRecompile());

    this.addCommand({
      id: "save-grid-file",
      name: "Save this grid as a .grid file…",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(GridView);
        if (!view) return false;
        if (!checking) void this.saveGridFile(view.scopeFolder());
        return true;
      },
    });

    this.addCommand({
      id: "scan-blank-duplicates",
      name: "Scan folder for blank or duplicate notes…",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(GridView);
        const grid = this.app.workspace
          .getLeavesOfType(GRID_VIEW_TYPE)
          .map((l) => l.view)
          .find((v): v is GridView => v instanceof GridView);
        const active = this.app.workspace.getActiveFile();
        const folder =
          view?.scopeFolder() ??
          grid?.scopeFolder() ??
          (active?.parent?.path === "/" ? "" : active?.parent?.path ?? "");
        new DiagnoseModal(this.app, folder).open();
      },
    });

    this.addCommand({
      id: "paste-import",
      name: "Import notes from a spreadsheet paste…",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(GridView);
        new PasteImportModal(this.app, this, view ? view.scopeFolder() : "").open();
      },
    });

    this.addCommand({
      id: "toggle-inline-props",
      name: "Toggle GridSense properties panel (all notes)",
      callback: async () => {
        this.settings.inlineProps = !this.settings.inlineProps;
        await this.saveSettings();
        this.inlineProps?.apply();
        new Notice(
          `GridSense properties panel: ${this.settings.inlineProps ? "on" : "off"} by default`
        );
      },
    });

    this.addCommand({
      id: "toggle-inline-props-note",
      name: "Toggle GridSense properties panel (this note)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md" || !this.inlineProps) return false;
        if (!checking) {
          const now = this.inlineProps.activeFor(file.path);
          void this.inlineProps.setOverride(file.path, !now).then(() =>
            new Notice(
              `GridSense properties for "${file.basename}": ${!now ? "on" : "off"} (overrides the default)`
            )
          );
        }
        return true;
      },
    });

    this.addCommand({
      id: "clear-inline-props-override",
      name: "Clear GridSense properties override (this note)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.settings.inlinePropsOverrides[file.path] === undefined) return false;
        if (!checking)
          void this.inlineProps?.setOverride(file.path, null).then(() =>
            new Notice("GridSense: note follows the default properties panel again")
          );
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
        menu.addItem((item) =>
          item
            .setTitle("Save as .grid file")
            .setIcon("save")
            .onClick(() => void this.saveGridFile(file.path === "/" ? "" : file.path))
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

  /** Write a .grid pointer file for a folder and open it. */
  async saveGridFile(folder: string): Promise<void> {
    const base = (folder.split("/").pop() || "vault").trim();
    // Parent folder of the scope — "" for a top-level folder (lastIndexOf
    // returns -1 there, and slice(0, -1) would eat the last character).
    const cut = folder.lastIndexOf("/");
    const dir = cut > 0 ? folder.slice(0, cut) : "";
    let path = `${dir ? dir + "/" : ""}${base}.grid`;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path))
      path = `${dir ? dir + "/" : ""}${base} ${n++}.grid`;
    try {
      const file = await this.app.vault.create(
        path,
        JSON.stringify({ gridsense: this.manifest.version, folder }, null, 2)
      );
      await this.app.workspace.getLeaf("tab").openFile(file as TFile);
      new Notice(`GridSense: saved "${path}"`);
    } catch (e) {
      new Notice(`GridSense: couldn't save the .grid file — ${String(e)}`);
    }
  }

  /** Property names seen anywhere in the vault (import/column mapping). */
  knownPropertyNames(): string[] {
    const out = new Set<string>();
    try {
      const mtm = (
        this.app as unknown as {
          metadataTypeManager?: { getAllProperties?: () => Record<string, unknown> };
        }
      ).metadataTypeManager;
      for (const k of Object.keys(mtm?.getAllProperties?.() ?? {})) out.add(k);
    } catch {
      /* undocumented API */
    }
    return [...out].sort();
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

    this.containerEl.createEl("div", { cls: "setting-item-heading", text: "Columns & views modal" });
    this.containerEl.createEl("div", {
      cls: "gridsense-props-hint",
      text: "Which sections start open. Each grid remembers its own choices and overrides these.",
    });
    const SECTIONS: { key: string; label: string; fallback: boolean }[] = [
      { key: "views", label: "Views", fallback: true },
      { key: "properties", label: "Properties", fallback: true },
      { key: "headings", label: "Heading columns", fallback: false },
      { key: "formulas", label: "Formula columns", fallback: false },
      { key: "tools", label: "Property tools", fallback: false },
      { key: "rows", label: "Rows & layout", fallback: false },
    ];
    for (const sec of SECTIONS)
      new Setting(this.containerEl).setName(sec.label).addToggle((t) =>
        t
          .setValue(this.plugin.settings.columnsSectionDefaults?.[sec.key] ?? sec.fallback)
          .onChange(async (v) => {
            this.plugin.settings.columnsSectionDefaults = {
              ...(this.plugin.settings.columnsSectionDefaults ?? {}),
              [sec.key]: v,
            };
            await this.plugin.saveSettings();
          })
      );
    new Setting(this.containerEl)
      .setName("Clear every grid's section overrides")
      .setDesc("Makes all grids follow the defaults above again.")
      .addButton((b) =>
        b.setButtonText("Clear overrides").onClick(async () => {
          let n = 0;
          for (const cfg of Object.values(this.plugin.settings.folders))
            if (cfg.sections) {
              delete cfg.sections;
              n++;
            }
          await this.plugin.saveSettings();
          new Notice(`GridSense: cleared section overrides on ${n} grid${n === 1 ? "" : "s"}`);
        })
      );

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
