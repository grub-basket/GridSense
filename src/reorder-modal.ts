import { App, Modal, Notice, Setting, TFile, setIcon } from "obsidian";
import type GridSensePlugin from "./main";
import type { EditEngine } from "./edits";
import { ConfirmModal } from "./formula-builder";
import { FieldSuggest } from "./suggest";
import {
  PropertyOrderPreset,
  ReorderChange,
  UnlistedMode,
  applyReorder,
  cleanKeyList,
  keyCounts,
  planReorder,
  replayReorder,
} from "./property-order";

/** Above this many changed notes, Apply asks first. */
const CONFIRM_ABOVE = 200;

export interface ReorderOptions {
  /** The open grid's folder scope ("" = vault root). Absent → vault only. */
  folder?: string;
  /** The notes that grid covers (same subfolder rule as the grid). */
  folderFiles?: () => TFile[];
  /** Frontmatter keys in the grid's current column order. */
  seed?: string[];
  /** The grid's undo stack, so the whole batch is one ⌘Z there. */
  engine?: EditEngine;
}

/**
 * "Reorder properties": apply one key order to many notes' frontmatter.
 * Values never change; only key order does, and notes already in order are
 * not written.
 */
export class ReorderPropertiesModal extends Modal {
  /** Which notes: the open grid's folder or the whole vault. */
  private where: "folder" | "vault";
  private keys: string[] = [];
  /** Keys the user took off the list ("don't manage this key"). */
  private removed = new Set<string>();
  private mode: UnlistedMode;
  private preset = "";
  private filesCache: TFile[] | null = null;
  private counts = new Map<string, number>();
  private listEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private applyBtn: HTMLButtonElement | null = null;
  private presetSetting: HTMLElement | null = null;
  private dragFrom = -1;

  constructor(app: App, private plugin: GridSensePlugin, private opts: ReorderOptions = {}) {
    super(app);
    this.where = opts.folderFiles ? "folder" : "vault";
    this.mode = plugin.settings.propertyOrderUnlisted ?? "after";
  }

  onOpen() {
    this.modalEl.addClass("gridsense-reorder-modal");
    this.titleEl.setText("Reorder properties");
    this.seed();
    this.renderBody();
  }

  onClose() {
    this.contentEl.empty();
  }

  // ------------------------------------------------------------------ data

  private files(): TFile[] {
    if (!this.filesCache)
      this.filesCache =
        this.where === "folder" && this.opts.folderFiles
          ? this.opts.folderFiles()
          : this.app.vault.getMarkdownFiles();
    return this.filesCache;
  }

  /** Grid column order first, then the scope's other keys by frequency. */
  private seed() {
    this.counts = keyCounts(this.app, this.files());
    const base = cleanKeyList(this.opts.seed ?? []);
    this.keys = [...base, ...this.otherKeys(new Set(base))];
  }

  /** Scope keys not in `skip` (nor removed), most frequent first. */
  private otherKeys(skip: Set<string>): string[] {
    return cleanKeyList(
      [...this.counts.entries()]
        .filter(([k]) => !skip.has(k) && !this.removed.has(k))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k]) => k)
    );
  }

  private setScope(scope: "folder" | "vault") {
    if (scope === this.where) return;
    this.where = scope;
    this.filesCache = null;
    this.counts = keyCounts(this.app, this.files());
    // Keep the list the user built; just pick up keys the new scope adds —
    // unless a saved order is loaded, whose list is exact by design.
    if (!this.preset) this.keys = [...this.keys, ...this.otherKeys(new Set(this.keys))];
    this.renderList();
    this.updatePreview();
  }

  // ---------------------------------------------------------------- render

  private renderBody() {
    const c = this.contentEl;
    c.empty();

    new Setting(c)
      .setName("Notes")
      .setDesc(
        this.opts.folderFiles
          ? "Which notes get reordered."
          : "Open a grid first to limit this to one folder."
      )
      .addDropdown((d) => {
        if (this.opts.folderFiles)
          d.addOption("folder", `This folder: ${this.opts.folder || "(vault root)"}`);
        d.addOption("vault", "Entire vault");
        d.setValue(this.where);
        d.onChange((v) => this.setScope(v === "folder" ? "folder" : "vault"));
      });

    this.presetSetting = c.createDiv();
    this.renderPresets();

    new Setting(c)
      .setName("Properties not in the list")
      .setDesc("Default comes from the plugin settings.")
      .addDropdown((d) =>
        d
          .addOption("after", "Go after the listed ones")
          .addOption("in-place", "Stay where they are")
          .setValue(this.mode)
          .onChange((v) => {
            this.mode = v === "in-place" ? "in-place" : "after";
            this.updatePreview();
          })
      );

    c.createDiv({
      cls: "gridsense-props-hint",
      text: "Drag a row, or use its arrows (Alt+↑/↓ on a focused row). Notes skip properties they don't have.",
    });
    this.listEl = c.createDiv({ cls: "gridsense-reorder-list", attr: { role: "list" } });
    this.renderList();

    const add = new Setting(c).setName("Add a property").setDesc("Put a removed or unseen property back on the list.");
    let addInput: HTMLInputElement | null = null;
    add.addText((t) => {
      addInput = t.inputEl;
      t.setPlaceholder("Property name");
      new FieldSuggest(this.app, t.inputEl, () => this.addCandidates(), {
        plainEnter: () => commitAdd(),
      });
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          commitAdd();
        }
      });
    });
    const commitAdd = () => {
      const k = cleanKeyList([addInput?.value ?? ""])[0];
      if (!k) return;
      if (!this.keys.includes(k)) this.keys.push(k);
      this.removed.delete(k);
      if (addInput) addInput.value = "";
      this.renderList();
      this.updatePreview();
    };
    add.addButton((b) => b.setButtonText("Add").onClick(commitAdd));
    add.addExtraButton((b) =>
      b
        .setIcon("rotate-ccw")
        .setTooltip(this.opts.seed ? "Start over from the grid's column order" : "Start over")
        .onClick(() => {
          this.removed.clear();
          this.preset = "";
          this.seed();
          this.renderPresets();
          this.renderList();
          this.updatePreview();
        })
    );

    c.createDiv({
      cls: "gridsense-props-hint",
      text: "Only the order of properties changes — values stay the same. Obsidian rewrites the frontmatter block when it saves, so quoting, spacing or list style in the YAML may be normalized, and comments inside the frontmatter are dropped.",
    });

    const foot = c.createDiv({ cls: "gridsense-reorder-foot" });
    this.previewEl = foot.createDiv({ cls: "gridsense-reorder-preview", attr: { "aria-live": "polite" } });
    const btns = foot.createDiv({ cls: "gridsense-reorder-buttons" });
    const cancel = btns.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    this.applyBtn = btns.createEl("button", { text: "Apply", cls: "mod-cta" });
    this.applyBtn.addEventListener("click", () => this.apply());
    this.updatePreview();
  }

  private addCandidates(): string[] {
    const listed = new Set(this.keys);
    const all = new Set<string>([...this.counts.keys(), ...this.plugin.knownPropertyNames()]);
    return cleanKeyList([...all].filter((k) => !listed.has(k)).sort((a, b) => a.localeCompare(b)));
  }

  private renderPresets() {
    const host = this.presetSetting;
    if (!host) return;
    host.empty();
    const presets = this.plugin.settings.propertyOrders ?? [];
    const s = new Setting(host).setName("Saved orders");
    if (presets.length)
      s.addDropdown((d) => {
        d.addOption("", "Load…");
        for (const p of presets) d.addOption(p.name, p.name);
        d.setValue(presets.some((p) => p.name === this.preset) ? this.preset : "");
        d.onChange((name) => {
          const p = presets.find((x) => x.name === name);
          if (!p) return;
          this.preset = p.name;
          this.keys = cleanKeyList(p.keys);
          this.removed.clear();
          this.mode = p.unlisted;
          // The mode dropdown lives outside this block; re-render everything.
          this.renderBody();
        });
      });
    s.addButton((b) =>
      b.setButtonText("Save as…").onClick(() =>
        new NamePromptModal(this.app, "Save property order", this.preset, async (name) => {
          const list = this.plugin.settings.propertyOrders;
          const existing = list.findIndex((p) => p.name === name);
          const save = async () => {
            const preset: PropertyOrderPreset = { name, keys: this.keys.slice(), unlisted: this.mode };
            if (existing >= 0) list[existing] = preset;
            else list.push(preset);
            await this.plugin.saveSettings();
            this.preset = name;
            this.renderPresets();
            new Notice(`GridSense: saved property order "${name}"`);
          };
          if (existing >= 0)
            new ConfirmModal(
              this.app,
              `Replace "${name}"?`,
              "A saved order with this name already exists.",
              "Replace",
              save
            ).open();
          else await save();
        }).open()
      )
    );
    if (this.preset && presets.some((p) => p.name === this.preset)) {
      s.addButton((b) =>
        b
          .setButtonText("Update")
          .setTooltip(`Overwrite "${this.preset}" with this list and setting`)
          .onClick(async () => {
            const p = this.plugin.settings.propertyOrders.find((x) => x.name === this.preset);
            if (!p) return;
            p.keys = this.keys.slice();
            p.unlisted = this.mode;
            await this.plugin.saveSettings();
            new Notice(`GridSense: updated property order "${p.name}"`);
          })
      );
      s.addExtraButton((b) =>
        b
          .setIcon("trash-2")
          .setTooltip(`Delete "${this.preset}"`)
          .onClick(() => {
            const name = this.preset;
            new ConfirmModal(this.app, `Delete "${name}"?`, "The saved order is removed from the plugin settings. Notes are not changed.", "Delete", async () => {
              this.plugin.settings.propertyOrders = this.plugin.settings.propertyOrders.filter(
                (p) => p.name !== name
              );
              await this.plugin.saveSettings();
              this.preset = "";
              this.renderPresets();
            }).open();
          })
      );
    }
  }

  private renderList(focus?: { index: number; part: "row" | "up" | "down" }) {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    if (!this.keys.length) {
      list.createDiv({ cls: "gridsense-props-empty", text: "No properties on the list." });
      return;
    }
    const total = this.files().length;
    this.keys.forEach((key, i) => {
      const row = list.createDiv({ cls: "gridsense-reorder-row", attr: { role: "listitem", tabindex: "0" } });
      row.setAttr("aria-label", `${key}, position ${i + 1} of ${this.keys.length}`);
      const grip = row.createDiv({ cls: "gridsense-reorder-grip", attr: { "aria-hidden": "true" } });
      setIcon(grip, "grip-vertical");
      grip.addEventListener("mousedown", () => (row.draggable = true));
      grip.addEventListener("mouseup", () => (row.draggable = false));
      row.addEventListener("dragstart", (e) => {
        this.dragFrom = i;
        e.dataTransfer?.setData("text/plain", key);
        row.addClass("is-dragging");
      });
      row.addEventListener("dragend", () => {
        // A cancelled drag must not leave a stale source for a later drop.
        this.dragFrom = -1;
        row.draggable = false;
        row.removeClass("is-dragging");
        list.querySelectorAll(".is-drop-target").forEach((el) => el.removeClass("is-drop-target"));
      });
      row.addEventListener("dragover", (e) => {
        if (this.dragFrom < 0) return;
        e.preventDefault();
        row.addClass("is-drop-target");
      });
      row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = this.dragFrom;
        this.dragFrom = -1;
        if (from >= 0) this.move(from, i, "row");
      });
      row.addEventListener("keydown", (e) => {
        if (e.target !== row || !e.altKey) return;
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          this.move(i, e.key === "ArrowUp" ? i - 1 : i + 1, "row");
        }
      });

      row.createSpan({ cls: "gridsense-reorder-key", text: key });
      const n = this.counts.get(key) ?? 0;
      row.createSpan({
        cls: "gridsense-reorder-count",
        text: `${n}/${total}`,
        attr: { title: `${n} of ${total} notes have "${key}"` },
      });
      const btn = (icon: string, label: string, part: string, fn: () => void, disabled = false) => {
        const b = row.createEl("button", { cls: "clickable-icon gridsense-reorder-btn", attr: { "aria-label": label, "data-part": part } });
        setIcon(b, icon);
        b.disabled = disabled;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          fn();
        });
        return b;
      };
      btn("arrow-up", `Move "${key}" up`, "up", () => this.move(i, i - 1, "up"), i === 0);
      btn("arrow-down", `Move "${key}" down`, "down", () => this.move(i, i + 1, "down"), i === this.keys.length - 1);
      btn("x", `Remove "${key}" from the list (don't manage it)`, "remove", () => {
        this.keys.splice(i, 1);
        this.removed.add(key);
        this.renderList({ index: Math.min(i, this.keys.length - 1), part: "row" });
        this.updatePreview();
      });
    });
    if (focus && focus.index >= 0) {
      const rowEl = list.children[focus.index] as HTMLElement | undefined;
      let target: HTMLElement | null | undefined = rowEl;
      if (focus.part !== "row") {
        const b = rowEl?.querySelector<HTMLButtonElement>(`button[data-part="${focus.part}"]`);
        // At the top/bottom the arrow just pressed is disabled: fall back to the row.
        target = b && !b.disabled ? b : rowEl;
      }
      target?.focus();
    }
  }

  private move(from: number, to: number, part: "row" | "up" | "down") {
    if (to < 0 || to >= this.keys.length || from === to) return;
    const [k] = this.keys.splice(from, 1);
    this.keys.splice(to, 0, k);
    this.renderList({ index: to, part });
    this.updatePreview();
  }

  private updatePreview() {
    const files = this.files();
    const n = planReorder(this.app, files, this.keys, this.mode).length;
    this.previewEl?.setText(
      `${n} of ${files.length} note${files.length === 1 ? "" : "s"} will change` +
        (n === 0 && files.length ? " — they're already in this order." : ".")
    );
    if (this.applyBtn) this.applyBtn.disabled = n === 0;
  }

  // ----------------------------------------------------------------- apply

  private apply() {
    const keys = this.keys.slice();
    const mode = this.mode;
    const targets = planReorder(this.app, this.files(), keys, mode);
    if (!targets.length) {
      new Notice("GridSense: every note is already in this order");
      return;
    }
    const run = async () => {
      this.close();
      await runReorder(this.app, this.plugin, targets, keys, mode, this.opts.engine);
    };
    if (targets.length > CONFIRM_ABOVE)
      new ConfirmModal(
        this.app,
        `Reorder properties in ${targets.length} notes?`,
        `Each of these notes gets its frontmatter rewritten with the same values in the new order. You can undo it as one step afterwards.`,
        "Reorder",
        run
      ).open();
    else void run();
  }
}

/** Run a batch reorder with a progress Notice and register one undo step. */
async function runReorder(
  app: App,
  plugin: GridSensePlugin,
  targets: TFile[],
  keys: string[],
  mode: UnlistedMode,
  engine?: EditEngine
) {
  const notice = new Notice(`GridSense: reordering properties 0/${targets.length}…`, 0);
  let result: { changes: ReorderChange[]; failed: string[] };
  try {
    result = await applyReorder(app, targets, keys, mode, (d, of) =>
      notice.setMessage(`GridSense: reordering properties ${d}/${of}…`)
    );
  } finally {
    notice.hide();
  }
  const { changes, failed } = result;
  const label = `reorder properties in ${changes.length} note${changes.length === 1 ? "" : "s"}`;
  const replay = (side: "before" | "after") => async () => {
    const verb = side === "before" ? "undoing" : "redoing";
    const pn = new Notice(`GridSense: ${verb} property reorder 0/${changes.length}…`, 0);
    let missing: string[] = [];
    try {
      ({ missing } = await replayReorder(app, changes, side, (d, of) =>
        pn.setMessage(`GridSense: ${verb} property reorder ${d}/${of}…`)
      ));
    } finally {
      pn.hide();
    }
    if (missing.length)
      new Notice(
        `GridSense: ${missing.length} note${missing.length === 1 ? " was" : "s were"} renamed, moved or deleted since the reorder and ${missing.length === 1 ? "was" : "were"} skipped: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`,
        10000
      );
  };
  const undo = replay("before");
  const redo = replay("after");
  if (failed.length)
    new Notice(
      `GridSense: couldn't reorder ${failed.length} note${failed.length === 1 ? "" : "s"}: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}`,
      10000
    );
  if (!changes.length) {
    new Notice("GridSense: nothing needed reordering");
    return;
  }
  if (engine) {
    // On the grid's own stack: ⌘Z / ⎌ undo there walks it back in one step.
    engine.pushUi(label, undo, redo);
    new Notice(`GridSense: reordered properties in ${changes.length} note${changes.length === 1 ? "" : "s"} — ⌘Z in the grid undoes it`);
    return;
  }
  // No grid: keep it on the plugin so the "Undo last property reorder"
  // command (and the Notice button) can take it back.
  const record = { label, undo, redo, undone: false };
  plugin.lastPropertyReorder = record;
  const frag = createFragment((f) => {
    f.createSpan({ text: `GridSense: reordered properties in ${changes.length} note${changes.length === 1 ? "" : "s"}. ` });
    const b = f.createEl("button", { text: "Undo" });
    // Bound to THIS batch: a newer reorder must not be undone from an older Notice.
    b.addEventListener("click", () => void plugin.undoLastPropertyReorder(record));
  });
  new Notice(frag, 15000);
}

/** Single-field name prompt (save a preset). */
export class NamePromptModal extends Modal {
  constructor(
    app: App,
    private heading: string,
    private initial: string,
    private onSubmit: (name: string) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(this.heading);
    let value = this.initial;
    const submit = () => {
      const name = value.trim();
      if (!name) return;
      this.close();
      void this.onSubmit(name);
    };
    new Setting(this.contentEl).setName("Name").addText((t) => {
      t.setValue(value).onChange((v) => (value = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          submit();
        }
      });
      window.setTimeout(() => t.inputEl.select(), 0);
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Save").setCta().onClick(submit));
  }

  onClose() {
    this.contentEl.empty();
  }
}
