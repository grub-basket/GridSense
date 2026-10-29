import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type GridSensePlugin from "./main";
import { ConfirmModal } from "./formula-builder";
import { FieldSuggest, filePathItems } from "./suggest";
import { NamePromptModal } from "./reorder-modal";
import { PropertyOrderPreset, parseOrders, sameKeyOrder, serializeOrders } from "./property-order";

/**
 * Settings tab section "Property orders": the saved orders used by
 * "Reorder properties in notes", plus export/import in the shared
 * property-orders format (the same file works in Bases Toolbox).
 */
export function renderPropertyOrdersSettings(
  containerEl: HTMLElement,
  plugin: GridSensePlugin,
  redraw: () => void
) {
  const app = plugin.app;
  const s = plugin.settings;
  containerEl.createDiv({ cls: "setting-item-heading", text: "Property orders" });
  containerEl.createDiv({
    cls: "gridsense-props-hint",
    text: "Saved orders for \"Reorder properties in notes\" (command palette, the grid's ↕ key order button, or a column header's menu). Reordering only changes the order of a note's properties, never their values.",
  });

  new Setting(containerEl)
    .setName("Properties not in the list")
    .setDesc("Default when reordering. After: listed properties first, the rest keep their order behind them. In place: the rest keep their exact positions.")
    .addDropdown((d) =>
      d
        .addOption("after", "Go after the listed ones")
        .addOption("in-place", "Stay where they are")
        .setValue(s.propertyOrderUnlisted)
        .onChange(async (v) => {
          s.propertyOrderUnlisted = v === "in-place" ? "in-place" : "after";
          await plugin.saveSettings();
        })
    );

  if (!s.propertyOrders.length)
    containerEl.createDiv({
      cls: "gridsense-props-hint",
      text: "No saved orders yet — use \"Save as…\" in the Reorder properties window, or import a file below.",
    });
  for (const preset of s.propertyOrders) {
    const shown = preset.keys.slice(0, 6).join(", ") + (preset.keys.length > 6 ? ", …" : "");
    new Setting(containerEl)
      .setName(preset.name)
      .setDesc(
        `${preset.keys.length} propert${preset.keys.length === 1 ? "y" : "ies"} · others ${preset.unlisted === "in-place" ? "stay in place" : "go after"}${shown ? " · " + shown : ""}`
      )
      .addExtraButton((b) =>
        b
          .setIcon("pencil")
          .setTooltip("Rename")
          .onClick(() =>
            new NamePromptModal(app, "Rename property order", preset.name, async (name) => {
              if (name === preset.name) return;
              if (s.propertyOrders.some((p) => p.name === name)) {
                new Notice(`GridSense: a property order named "${name}" already exists`);
                return;
              }
              preset.name = name;
              await plugin.saveSettings();
              redraw();
            }).open()
          )
      )
      .addExtraButton((b) =>
        b
          .setIcon("trash-2")
          .setTooltip("Delete")
          .onClick(() =>
            new ConfirmModal(
              app,
              `Delete "${preset.name}"?`,
              "The saved order is removed from the plugin settings. Notes are not changed.",
              "Delete",
              async () => {
                s.propertyOrders = s.propertyOrders.filter((p) => p !== preset);
                await plugin.saveSettings();
                redraw();
              }
            ).open()
          )
      );
  }

  // ---------------------------------------------------------------- export
  let exportPath = s.propertyOrdersExportPath;
  new Setting(containerEl)
    .setName("Export")
    .setDesc("Copies every saved order to the clipboard as JSON and saves it to this vault file.")
    .addText((t) => {
      t.setPlaceholder("property-orders.json").setValue(exportPath);
      new FieldSuggest(app, t.inputEl, () => filePathItems(app, ["json"]));
      t.onChange(async (v) => {
        exportPath = v;
        s.propertyOrdersExportPath = v.trim() || "property-orders.json";
        await plugin.saveSettings();
      });
    })
    .addButton((b) =>
      b.setButtonText("Export").onClick(() => void exportOrders(plugin, exportPath))
    );

  // ---------------------------------------------------------------- import
  let importPath = "";
  new Setting(containerEl)
    .setName("Import from a file")
    .setDesc("A .json file in this vault, exported from GridSense or Bases Toolbox. Orders merge by name.")
    .addText((t) => {
      t.setPlaceholder("property-orders.json");
      new FieldSuggest(app, t.inputEl, () => filePathItems(app, ["json"]));
      t.onChange((v) => (importPath = v));
    })
    .addButton((b) =>
      b.setButtonText("Import").onClick(async () => {
        const path = normalizePath(importPath.trim());
        const file = path ? app.vault.getAbstractFileByPath(path) : null;
        if (!(file instanceof TFile)) {
          new Notice(`GridSense: no file at "${importPath.trim() || "(empty path)"}"`);
          return;
        }
        importOrdersText(plugin, await app.vault.read(file), redraw);
      })
    );

  let pasted = "";
  const paste = new Setting(containerEl)
    .setName("Import pasted JSON")
    .setDesc("Paste an export here. Orders merge by name; you're asked before a same-named order is replaced.");
  paste.addTextArea((t) => {
    t.setPlaceholder('{ "format": "property-orders", "version": 1, "orders": [ … ] }');
    t.inputEl.rows = 3;
    t.inputEl.addClass("gridsense-orders-paste");
    t.onChange((v) => (pasted = v));
  });
  paste.addButton((b) =>
    b.setButtonText("Import").onClick(() => {
      if (!pasted.trim()) {
        new Notice("GridSense: paste a property-orders export first");
        return;
      }
      importOrdersText(plugin, pasted, redraw);
    })
  );
}

/** Validate a user-typed vault path for the export file. */
function exportTarget(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const p = normalizePath(t);
  if (p.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  if (!p.toLowerCase().endsWith(".json")) return null;
  return p;
}

async function exportOrders(plugin: GridSensePlugin, rawPath: string) {
  const app = plugin.app;
  const orders = plugin.settings.propertyOrders;
  if (!orders.length) {
    new Notice("GridSense: no saved property orders to export");
    return;
  }
  const path = exportTarget(rawPath || "property-orders.json");
  if (!path) {
    new Notice("GridSense: the export path must be a vault path ending in .json");
    return;
  }
  const json = serializeOrders(orders);
  let copied = false;
  try {
    await navigator.clipboard.writeText(json);
    copied = true;
  } catch {
    /* clipboard can be unavailable (permissions, mobile) — the file still saves */
  }
  const write = async () => {
    try {
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await app.vault.modify(existing, json);
      else {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && !(app.vault.getAbstractFileByPath(dir) instanceof TFolder))
          await app.vault.createFolder(dir);
        await app.vault.create(path, json);
      }
      new Notice(
        `GridSense: exported ${orders.length} property order${orders.length === 1 ? "" : "s"} to "${path}"${copied ? " and the clipboard" : ""}`
      );
    } catch (e) {
      new Notice(
        `GridSense: couldn't save "${path}" — ${String(e)}${copied ? " (the JSON is on the clipboard)" : ""}`
      );
    }
  };
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing && !(existing instanceof TFile)) {
    new Notice(`GridSense: "${path}" is a folder`);
    return;
  }
  if (existing instanceof TFile)
    new ConfirmModal(
      app,
      `Replace "${path}"?`,
      `That file already exists. It will be overwritten with the ${orders.length} saved order${orders.length === 1 ? "" : "s"}.${copied ? " The JSON is already on the clipboard either way." : ""}`,
      "Replace",
      write
    ).open();
  else await write();
}

const samePreset = (a: PropertyOrderPreset, b: PropertyOrderPreset) =>
  a.unlisted === b.unlisted && sameKeyOrder(a.keys, b.keys);

/** Parse + merge an export into the settings, asking before replacing. */
export function importOrdersText(plugin: GridSensePlugin, text: string, done: () => void) {
  const parsed = parseOrders(text);
  if (!parsed.ok) {
    new Notice(`GridSense: can't import — ${parsed.error}`, 8000);
    return;
  }
  const list = plugin.settings.propertyOrders;
  const fresh: PropertyOrderPreset[] = [];
  const conflicts: PropertyOrderPreset[] = [];
  let same = 0;
  for (const o of parsed.orders) {
    const mine = list.find((p) => p.name === o.name);
    if (!mine) fresh.push(o);
    else if (samePreset(mine, o)) same++;
    else conflicts.push(o);
  }
  const finish = async (overwrite: boolean) => {
    for (const o of fresh) list.push(o);
    if (overwrite)
      for (const o of conflicts) {
        const i = list.findIndex((p) => p.name === o.name);
        if (i >= 0) list[i] = o;
      }
    await plugin.saveSettings();
    const parts = [`added ${fresh.length}`];
    if (conflicts.length) parts.push(overwrite ? `replaced ${conflicts.length}` : `kept ${conflicts.length} of yours`);
    if (same) parts.push(`${same} already identical`);
    new Notice(`GridSense: imported property orders — ${parts.join(", ")}`);
    done();
  };
  if (!conflicts.length) {
    void finish(false);
    return;
  }
  new ImportConflictModal(plugin.app, conflicts.map((c) => c.name), fresh.length, finish).open();
}

/** "These names already exist — replace them?" with a keep-mine option. */
class ImportConflictModal extends Modal {
  constructor(
    app: App,
    private names: string[],
    private freshCount: number,
    private onChoose: (overwrite: boolean) => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const n = this.names.length;
    this.titleEl.setText(`${n} saved order${n === 1 ? "" : "s"} already exist${n === 1 ? "s" : ""}`);
    this.contentEl.createEl("p", {
      text: `The import has different versions of: ${this.names.join(", ")}. Replace yours with the imported ones?${this.freshCount ? ` (${this.freshCount} new order${this.freshCount === 1 ? " is" : "s are"} added either way.)` : ""}`,
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel import").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Keep mine").onClick(() => {
          this.close();
          void this.onChoose(false);
        })
      )
      .addButton((b) =>
        b
          .setButtonText("Replace")
          .setWarning()
          .onClick(() => {
            this.close();
            void this.onChoose(true);
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
