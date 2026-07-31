import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type GridSensePlugin from "./main";
import { ListSuggest, allFolderPaths } from "./formula-builder";
import { parseInput } from "./edits";

/**
 * Spreadsheet clipboard text → cells. Quoted multi-line cells (Excel/Sheets
 * escape embedded quotes as "") survive intact, and CRLF / unicode row
 * separators are normalized.
 */
export function parseClipboardTable(text: string): string[][] {
  const SENTINEL = "\u0000";
  let t = text.replace(/\r\n?/g, "\n").replace(/[\u0085\u2028\u2029]/g, "\n");
  t = t.replace(/"([^\t"]*(?:""[^\t"]*)*\n[^\t"]*(?:""[^\t"]*)*)"/g, (_m, cell: string) =>
    cell.replace(/\n/g, SENTINEL).replace(/""/g, '"')
  );
  return t
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => l.split("\t").map((c) => c.split(SENTINEL).join("\n")));
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Staging import: paste a spreadsheet, map columns to properties, then create
 * the notes in one go. Nothing touches the vault until you press Create — and
 * the raw paste is backed up to a CSV first, so a botched import can be redone
 * from that file instead of re-copying from the source app.
 */
export class PasteImportModal extends Modal {
  private table: string[][] = [];
  private hasHeader = true;
  private nameCol = 0;
  private props: string[] = [];
  private folder: string;
  private backupPath = "";

  constructor(app: App, private plugin: GridSensePlugin, folder: string) {
    super(app);
    this.folder = folder;
  }

  onOpen() {
    this.modalEl.addClass("gridsense-import-modal");
    this.titleEl.setText("Import from a spreadsheet");
    this.renderBody();
  }

  private renderBody() {
    const c = this.contentEl;
    c.empty();

    if (!this.table.length) {
      c.createDiv({
        cls: "gridsense-props-hint",
        text: "Copy cells in Excel, Google Sheets, Numbers or LibreOffice, then paste them below. Nothing is written to your vault until you press Create notes.",
      });
      const ta = c.createEl("textarea", {
        cls: "gridsense-zoom-text",
        attr: { placeholder: "Paste spreadsheet cells here…" },
      });
      ta.addEventListener("paste", (e) => {
        const text = e.clipboardData?.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        this.ingest(text);
      });
      window.setTimeout(() => ta.focus(), 0);
      new Setting(c).addButton((b) =>
        b
          .setButtonText("Use pasted text")
          .setCta()
          .onClick(() => {
            if (!ta.value.trim()) {
              new Notice("GridSense: nothing pasted yet");
              return;
            }
            this.ingest(ta.value);
          })
      );
      return;
    }

    const body = this.hasHeader ? this.table.slice(1) : this.table;
    c.createDiv({
      cls: "gridsense-props-hint",
      text: `${body.length} row${body.length === 1 ? "" : "s"} × ${this.table[0].length} column${this.table[0].length === 1 ? "" : "s"} staged. Fix the mapping below, or repaste to start over.`,
    });

    new Setting(c)
      .setName("First row is a header")
      .setDesc("Use row 1 as property names instead of data.")
      .addToggle((t) =>
        t.setValue(this.hasHeader).onChange((v) => {
          this.hasHeader = v;
          this.seedProps();
          this.renderBody();
        })
      );

    new Setting(c).setName("Create notes in").addText((t) => {
      t.setValue(this.folder);
      t.setPlaceholder("(vault root)");
      new ListSuggest(this.app, t.inputEl, () => allFolderPaths(this.app));
      t.onChange((v) => (this.folder = v.trim()));
    });

    new Setting(c)
      .setName("Note name column")
      .setDesc("Its value becomes each note's file name.")
      .addDropdown((d) => {
        this.table[0].forEach((_, i) => d.addOption(String(i), this.props[i] || `Column ${i + 1}`));
        d.setValue(String(this.nameCol)).onChange((v) => {
          this.nameCol = parseInt(v);
          this.renderBody();
        });
      });

    c.createEl("div", { cls: "setting-item-heading", text: "Columns → properties" });
    c.createDiv({
      cls: "gridsense-props-hint",
      text: "Clear a name to skip that column. Values are typed the same way as grid edits.",
    });
    this.table[0].forEach((_, i) => {
      new Setting(c)
        .setName(`Column ${i + 1}`)
        .setDesc((body[0]?.[i] ?? "").slice(0, 60) || "(empty in the first row)")
        .addText((t) => {
          t.setValue(this.props[i] ?? "");
          t.setPlaceholder("(skip)");
          new ListSuggest(this.app, t.inputEl, () => this.plugin.knownPropertyNames());
          t.onChange((v) => (this.props[i] = v.trim()));
        });
    });

    // Preview so problems are visible before anything is created.
    c.createEl("div", { cls: "setting-item-heading", text: "Preview" });
    const table = c.createEl("table", { cls: "gridsense-import-preview" });
    const head = table.createEl("tr");
    head.createEl("th", { text: "note name" });
    this.props.forEach((p, i) => {
      if (i !== this.nameCol && p) head.createEl("th", { text: p });
    });
    for (const row of body.slice(0, 5)) {
      const tr = table.createEl("tr");
      tr.createEl("td", { text: this.safeName(row[this.nameCol] ?? "") || "⚠ no name" });
      this.props.forEach((p, i) => {
        if (i !== this.nameCol && p) tr.createEl("td", { text: (row[i] ?? "").slice(0, 40) });
      });
    }
    if (body.length > 5)
      c.createDiv({ cls: "gridsense-props-hint", text: `…and ${body.length - 5} more rows.` });

    new Setting(c)
      .addButton((b) =>
        b.setButtonText("Repaste").onClick(() => {
          this.table = [];
          this.renderBody();
        })
      )
      .addButton((b) =>
        b
          .setButtonText(`Create ${body.length} note${body.length === 1 ? "" : "s"}`)
          .setCta()
          .onClick(() => void this.commit(body))
      );
  }

  private ingest(text: string) {
    this.table = parseClipboardTable(text).filter((r) => r.some((cell) => cell.trim() !== ""));
    if (!this.table.length) {
      new Notice("GridSense: couldn't find any rows in that paste");
      return;
    }
    this.seedProps();
    void this.backup();
    this.renderBody();
  }

  private seedProps() {
    const width = this.table[0]?.length ?? 0;
    this.props = [];
    for (let i = 0; i < width; i++)
      this.props[i] = this.hasHeader ? (this.table[0][i] ?? "").trim() : `column${i + 1}`;
  }

  private safeName(v: string): string {
    return v.trim().replace(/[\\/:]+/g, "-").slice(0, 180);
  }

  /**
   * Always keep a copy of the raw paste — losing the staging table shouldn't
   * mean going back to the source app to copy again.
   */
  private async backup(): Promise<void> {
    try {
      const dir = normalizePath(`${this.app.vault.configDir}/plugins/gridsense/imports`);
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const csv = this.table.map((r) => r.map(csvEscape).join(",")).join("\n");
      const p = normalizePath(`${dir}/paste-${stamp}.csv`);
      await adapter.write(p, csv);
      this.backupPath = p;
    } catch {
      /* backup is best-effort; never block the import */
    }
  }

  private async commit(body: string[][]) {
    const dir = this.folder.replace(/^\/+|\/+$/g, "");
    if (dir && !(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder))
      await this.app.vault.createFolder(dir).catch(() => undefined);
    let made = 0;
    let skipped = 0;
    const renamed: string[] = [];
    for (const row of body) {
      const name = this.safeName(row[this.nameCol] ?? "");
      if (!name) {
        skipped++;
        continue;
      }
      let path = normalizePath(`${dir ? dir + "/" : ""}${name}.md`);
      let n = 2;
      const wanted = path;
      while (this.app.vault.getAbstractFileByPath(path))
        path = normalizePath(`${dir ? dir + "/" : ""}${name} (${n++}).md`);
      // Never silently shadow an existing note with a near-identical name —
      // that reads as "a blank duplicate appeared".
      if (path !== wanted) renamed.push(path.split("/").pop() ?? path);
      try {
        const file = (await this.app.vault.create(path, "---\n---\n")) as TFile;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          this.props.forEach((p, i) => {
            if (!p || i === this.nameCol) return;
            const raw = (row[i] ?? "").trim();
            if (raw === "") return;
            fm[p] = parseInput(raw, undefined);
          });
        });
        made++;
      } catch {
        skipped++;
      }
    }
    this.close();
    new Notice(
      `GridSense: created ${made} note${made === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}.` +
        (renamed.length
          ? ` ${renamed.length} had a name that already existed and became: ${renamed.slice(0, 3).join(", ")}${renamed.length > 3 ? "…" : ""}.`
          : "") +
        (this.backupPath ? " A CSV of the paste was saved in the plugin folder." : ""),
      renamed.length ? 12000 : undefined
    );
  }
}
