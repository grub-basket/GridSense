import { AbstractInputSuggest, App, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type GridSensePlugin from "./main";
import { FormulaSpec } from "./types";
import { valueToDisplay } from "./edits";
import { allHeadings } from "./headings";

/** Generic type-to-filter suggest over a dynamic string list. */
export class ListSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private itemsFn: () => string[]
  ) {
    super(app, inputEl);
    this.limit = 0;
  }

  getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    const items = this.itemsFn();
    if (!q || items.some((i) => i.toLowerCase() === q)) return items;
    return items.filter((i) => i.toLowerCase().includes(q));
  }

  renderSuggestion(item: string, el: HTMLElement): void {
    el.setText(item);
  }

  selectSuggestion(item: string): void {
    this.inputEl.value = item;
    this.inputEl.dispatchEvent(new Event("input"));
    this.close();
  }
}

export function allFolderPaths(app: App): string[] {
  const out: string[] = [];
  const walk = (f: TFolder) => {
    out.push(f.path === "/" ? "" : f.path);
    for (const c of f.children) if (c instanceof TFolder) walk(c);
  };
  walk(app.vault.getRoot());
  return out.sort();
}

function filesInDir(app: App, dirPath: string): TFile[] {
  const root = app.vault.getAbstractFileByPath(dirPath === "" ? "/" : dirPath);
  const files: TFile[] = [];
  const visit = (f: TFolder) => {
    for (const c of f.children) {
      if (c instanceof TFolder) visit(c);
      else if (c instanceof TFile && c.extension === "md") files.push(c);
    }
  };
  if (root instanceof TFolder) visit(root);
  return files;
}

export function propsInDir(app: App, dirPath: string): string[] {
  const keys = new Set<string>();
  for (const f of filesInDir(app, dirPath)) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter ?? {};
    for (const k of Object.keys(fm)) if (k !== "position") keys.add(k);
  }
  return [...keys].sort();
}

export function headingsInDir(app: App, dirPath: string): string[] {
  return allHeadings(app, filesInDir(app, dirPath));
}

/**
 * XLOOKUP / XMATCH / heading-mapping builder for a folder scope. Shared by
 * the grid's columns manager and the per-note properties strip — formulas
 * live in FolderConfig, so defining one anywhere lights it up everywhere.
 */
export class FormulaBuilderModal extends Modal {
  private spec: FormulaSpec;

  constructor(
    app: App,
    private plugin: GridSensePlugin,
    private folder: string,
    existing: FormulaSpec | null,
    private onSaved: () => void | Promise<void>
  ) {
    super(app);
    this.spec = existing
      ? { ...existing }
      : {
          name: "",
          type: "xlookup",
          lookupProp: "",
          searchDir: "",
          matchProp: "",
          returnProp: "",
          returnHeading: "",
          notFound: "",
        };
  }

  onOpen() {
    this.titleEl.setText(this.spec.name ? `Edit formula — ${this.spec.name}` : "Add formula column");
    const c = this.contentEl;
    const app = this.app;

    new Setting(c)
      .setName("Column name")
      .setDesc("Also the default lookup property")
      .addText((t) => {
        t.setValue(this.spec.name);
        t.onChange((v) => (this.spec.name = v.trim()));
        window.setTimeout(() => t.inputEl.focus(), 0);
      });

    new Setting(c).setName("Formula").addDropdown((d) => {
      d.addOption("xlookup", "XLOOKUP — return a value from the matched note");
      d.addOption("xmatch", "XMATCH — return the match's position in the folder");
      d.setValue(this.spec.type).onChange((v) => (this.spec.type = v as "xlookup" | "xmatch"));
    });

    new Setting(c)
      .setName("Lookup property (this grid)")
      .setDesc("Row value to look up — leave empty to use the column name")
      .addText((t) => {
        t.setValue(this.spec.lookupProp);
        t.setPlaceholder("defaults to column name");
        new ListSuggest(app, t.inputEl, () => propsInDir(app, this.folder));
        t.onChange((v) => (this.spec.lookupProp = v.trim()));
      });

    new Setting(c)
      .setName("Search directory")
      .setDesc("Folder whose notes are searched")
      .addText((t) => {
        t.setValue(this.spec.searchDir);
        t.setPlaceholder("(vault root)");
        new ListSuggest(app, t.inputEl, () => allFolderPaths(app));
        t.onChange((v) => (this.spec.searchDir = v.trim()));
      });

    new Setting(c).setName("Match property (searched notes)").addText((t) => {
      t.setValue(this.spec.matchProp);
      new ListSuggest(app, t.inputEl, () => propsInDir(app, this.spec.searchDir));
      t.onChange((v) => (this.spec.matchProp = v.trim()));
    });

    new Setting(c)
      .setName("Return property")
      .setDesc("XLOOKUP only — leave empty to return the note name")
      .addText((t) => {
        t.setValue(this.spec.returnProp ?? "");
        new ListSuggest(app, t.inputEl, () => propsInDir(app, this.spec.searchDir));
        t.onChange((v) => (this.spec.returnProp = v.trim()));
      });

    new Setting(c)
      .setName("…or return heading section")
      .setDesc("Heading-mapping: return the matched note's content under this heading")
      .addText((t) => {
        t.setValue(this.spec.returnHeading ?? "");
        new ListSuggest(app, t.inputEl, () => headingsInDir(app, this.spec.searchDir));
        t.onChange((v) => (this.spec.returnHeading = v.trim()));
      });

    new Setting(c).setName("If not found").addText((t) => {
      t.setValue(this.spec.notFound);
      t.setPlaceholder("(empty)");
      new ListSuggest(app, t.inputEl, () => {
        const prop = this.spec.returnProp;
        if (!prop) return [];
        const vals = new Set<string>();
        for (const f of filesInDir(app, this.spec.searchDir)) {
          const v = app.metadataCache.getFileCache(f)?.frontmatter?.[prop];
          if (v !== undefined && v !== null) vals.add(valueToDisplay(v));
        }
        return [...vals].sort().slice(0, 200);
      });
      t.onChange((v) => (this.spec.notFound = v));
    });

    new Setting(c).addButton((b) =>
      b
        .setButtonText(this.spec.name ? "Save" : "Add")
        .setCta()
        .onClick(async () => {
          if (!this.spec.name) {
            new Notice("GridSense: the formula column needs a name");
            return;
          }
          if (!this.spec.matchProp) {
            new Notice("GridSense: pick a match property");
            return;
          }
          const cfg = this.plugin.folderConfig(this.folder);
          cfg.formulas = (cfg.formulas ?? []).filter((f) => f.name !== this.spec.name);
          cfg.formulas.push(this.spec);
          await this.plugin.saveSettings();
          this.close();
          await this.onSaved();
        })
    );
  }
}

/** Small confirm dialog for destructive actions. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private body: string,
    private cta: string,
    private onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.body });
    new Setting(this.contentEl)
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => this.close())
      )
      .addButton((b) =>
        b
          .setButtonText(this.cta)
          .setWarning()
          .onClick(async () => {
            this.close();
            await this.onConfirm();
          })
      );
  }
}

/** Rename a note (updates links via Obsidian's fileManager). */
export class RenameFileModal extends Modal {
  constructor(app: App, private file: TFile) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(`Rename — ${this.file.basename}`);
    let value = this.file.basename;
    new Setting(this.contentEl)
      .setName("New name")
      .setDesc("Links to this note are updated automatically.")
      .addText((t) => {
        t.setValue(value);
        t.onChange((v) => (value = v));
        window.setTimeout(() => {
          t.inputEl.focus();
          t.inputEl.select();
        }, 0);
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void this.commit(value);
          }
        });
      });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Rename").setCta().onClick(() => void this.commit(value))
    );
  }

  private async commit(value: string) {
    const name = value.trim().replace(/[\\/:]+/g, "-");
    if (!name || name === this.file.basename) {
      this.close();
      return;
    }
    const dir = this.file.parent?.path === "/" ? "" : this.file.parent?.path ?? "";
    const newPath = `${dir ? dir + "/" : ""}${name}.${this.file.extension}`;
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      new Notice("GridSense: a note with that name already exists here");
      return;
    }
    try {
      await this.app.fileManager.renameFile(this.file, newPath);
      new Notice(`GridSense: renamed to "${name}"`);
      this.close();
    } catch (e) {
      new Notice(`GridSense: rename failed: ${String(e)}`);
    }
  }
}
