import { AbstractInputSuggest, App, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type GridSensePlugin from "./main";
import { Condition, FormulaSpec } from "./types";
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
      d.addOption("xlookup", "XLOOKUP — value from a matched note");
      d.addOption("xmatch", "XMATCH — position of the matched note");
      d.addOption("countif", "COUNTIF — how many notes meet conditions");
      d.addOption("sumif", "SUMIF — total a property where conditions hold");
      d.addOption("concat", "CONCAT — join properties and text");
      d.addOption("if", "IF — one value when conditions hold, another when not");
      d.addOption("ifs", "IFS — first matching condition wins");
      d.addOption("and", "AND — true only when every condition holds");
      d.setValue(this.spec.type).onChange((v) => {
        this.spec.type = v as FormulaSpec["type"];
        this.contentEl.empty();
        this.onOpen();
      });
    });

    // Fields differ per formula; lookups keep the original layout.
    if (this.spec.type !== "xlookup" && this.spec.type !== "xmatch") {
      this.renderSimpleFields(c);
      return;
    }

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

  /** Condition/parts UI for COUNTIF, SUMIF, CONCAT, IF, IFS and AND. */
  private renderSimpleFields(c: HTMLElement) {
    const app = this.app;
    const props = () => propsInDir(app, this.folder);
    const type = this.spec.type;

    if (type === "concat") {
      this.spec.parts = this.spec.parts ?? [];
      new Setting(c)
        .setName("Separator")
        .setDesc("Placed between the joined parts.")
        .addText((t) => {
          t.setPlaceholder("space");
          t.setValue(this.spec.separator ?? " ");
          t.onChange((v) => (this.spec.separator = v));
        });
      c.createEl("div", { cls: "setting-item-heading", text: "Parts" });
      c.createDiv({
        cls: "gridsense-props-hint",
        text:
          'A property name uses that property\'s value; file.basename / file.path / file.folder work too; wrap text in quotes for a literal, e.g. "—".',
      });
      const redraw = () => {
        this.contentEl.empty();
        this.onOpen();
      };
      this.spec.parts.forEach((part, i) => {
        new Setting(c)
          .setName(`Part ${i + 1}`)
          .addText((t) => {
            t.setValue(part);
            new ListSuggest(app, t.inputEl, () => [
              "file.basename",
              "file.path",
              "file.folder",
              ...props(),
            ]);
            t.onChange((v) => (this.spec.parts![i] = v));
          })
          .addExtraButton((b) =>
            b.setIcon("trash").onClick(() => {
              this.spec.parts!.splice(i, 1);
              redraw();
            })
          );
      });
      new Setting(c).addButton((b) =>
        b.setButtonText("Add part").onClick(() => {
          this.spec.parts!.push("");
          redraw();
        })
      );
    } else {
      if (type === "sumif")
        new Setting(c)
          .setName("Property to total")
          .addText((t) => {
            t.setValue(this.spec.sumProp ?? "");
            new ListSuggest(app, t.inputEl, props);
            t.onChange((v) => (this.spec.sumProp = v.trim()));
          });
      if (type === "countif" || type === "sumif")
        new Setting(c)
          .setName("Count within")
          .setDesc("Folder to scan — leave empty to use this grid's notes.")
          .addText((t) => {
            t.setValue(this.spec.countDir ?? "");
            t.setPlaceholder("(this grid)");
            new ListSuggest(app, t.inputEl, () => allFolderPaths(app));
            t.onChange((v) => (this.spec.countDir = v.trim()));
          });

      this.spec.conditions = this.spec.conditions ?? [];
      c.createEl("div", { cls: "setting-item-heading", text: "Conditions" });
      c.createDiv({
        cls: "gridsense-props-hint",
        text:
          type === "ifs"
            ? "Checked top to bottom; the first match supplies the value."
            : "All conditions must hold.",
      });
      const redraw = () => {
        this.contentEl.empty();
        this.onOpen();
      };
      this.spec.conditions.forEach((cond, i) => {
        const setting = new Setting(c)
          .setName(`When`)
          .addText((t) => {
            t.setPlaceholder("property");
            t.setValue(cond.prop);
            new ListSuggest(app, t.inputEl, props);
            t.onChange((v) => (cond.prop = v.trim()));
          })
          .addDropdown((d) => {
            for (const op of ["=", "!=", ">", "<", ">=", "<=", "contains", "empty", "not-empty"])
              d.addOption(op, op);
            d.setValue(cond.op).onChange((v) => (cond.op = v as Condition["op"]));
          })
          .addText((t) => {
            t.setPlaceholder("value");
            t.setValue(cond.value);
            t.onChange((v) => (cond.value = v));
          });
        if (type === "ifs")
          setting.addText((t) => {
            t.setPlaceholder("→ result");
            t.setValue(cond.then ?? "");
            t.onChange((v) => (cond.then = v));
          });
        setting.addExtraButton((b) =>
          b.setIcon("trash").onClick(() => {
            this.spec.conditions!.splice(i, 1);
            redraw();
          })
        );
      });
      new Setting(c).addButton((b) =>
        b.setButtonText("Add condition").onClick(() => {
          this.spec.conditions!.push({ prop: "", op: "=", value: "" });
          redraw();
        })
      );

      if (type === "if" || type === "and") {
        new Setting(c).setName("Value when true").addText((t) => {
          t.setValue(this.spec.thenValue ?? "");
          t.setPlaceholder("true");
          t.onChange((v) => (this.spec.thenValue = v));
        });
        new Setting(c).setName("Value when false").addText((t) => {
          t.setValue(this.spec.elseValue ?? "");
          t.setPlaceholder(type === "and" ? "false" : "(empty)");
          t.onChange((v) => (this.spec.elseValue = v));
        });
      }
      if (type === "ifs")
        new Setting(c).setName("Value when nothing matches").addText((t) => {
          t.setValue(this.spec.notFound ?? "");
          t.onChange((v) => (this.spec.notFound = v));
        });
    }

    new Setting(c).addButton((b) =>
      b
        .setButtonText(this.spec.name ? "Save" : "Add")
        .setCta()
        .onClick(async () => {
          if (!this.spec.name) {
            new Notice("GridSense: the formula column needs a name");
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
