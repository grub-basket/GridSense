import { App, Modal, Notice, Setting, TFile, TFolder } from "obsidian";

interface BlankNote {
  file: TFile;
  reason: "empty" | "frontmatter-only";
}

interface NameGroup {
  stem: string;
  files: TFile[];
}

/** "Note (2)", "Note 1", "Note copy" all reduce to the same stem. */
function nameStem(basename: string): string {
  return basename
    .replace(/\s*(\(\d+\)|\(copy(\s+\d+)?\)|\s\d+)$/i, "")
    .trim()
    .toLowerCase();
}

function filesIn(app: App, folder: string): TFile[] {
  const root = app.vault.getAbstractFileByPath(folder === "" ? "/" : folder);
  const out: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const c of f.children) {
      if (c instanceof TFolder) walk(c);
      else if (c instanceof TFile && c.extension === "md") out.push(c);
    }
  };
  if (root instanceof TFolder) walk(root);
  else if (folder === "" || folder === "/") out.push(...app.vault.getMarkdownFiles());
  return out;
}

/**
 * Blank-and-duplicate scan.
 *
 * A user reported a blank copy of a note appearing during heavy grid editing.
 * GridSense's own create paths refuse to write over an existing name, and the
 * forensic trail went cold because the file had already been deleted — so this
 * exists to capture the evidence the moment it happens again: which notes are
 * empty, which names look like copies of each other, and when they were made.
 */
export async function scanFolder(
  app: App,
  folder: string
): Promise<{ blanks: BlankNote[]; groups: NameGroup[]; total: number }> {
  const files = filesIn(app, folder);
  const blanks: BlankNote[] = [];
  for (const file of files) {
    if (file.stat.size > 2000) continue; // a real note; skip the read
    const text = await app.vault.cachedRead(file);
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    if (body === "") blanks.push({ file, reason: text.trim() === "" ? "empty" : "frontmatter-only" });
  }
  const byStem = new Map<string, TFile[]>();
  for (const file of files) {
    const key = `${file.parent?.path ?? ""}::${nameStem(file.basename)}`;
    byStem.set(key, [...(byStem.get(key) ?? []), file]);
  }
  const groups: NameGroup[] = [];
  for (const [key, group] of byStem) {
    if (group.length < 2) continue;
    const stem = key.split("::")[1];
    // "Rec 1 … Rec 200" are just numbered notes, not copies. Only flag a group
    // when the un-suffixed name ALSO exists — that's what a copy looks like.
    if (!group.some((f) => f.basename.trim().toLowerCase() === stem)) continue;
    groups.push({ stem, files: group });
  }
  return { blanks, groups, total: files.length };
}

export class DiagnoseModal extends Modal {
  constructor(app: App, private folder: string) {
    super(app);
  }

  async onOpen() {
    this.modalEl.addClass("gridsense-history-modal");
    this.titleEl.setText(`Blank & duplicate scan — ${this.folder || "(vault)"}`);
    const c = this.contentEl;
    c.createDiv({ cls: "gridsense-props-hint", text: "Scanning…" });
    const { blanks, groups, total } = await scanFolder(this.app, this.folder);
    c.empty();
    c.createDiv({
      cls: "gridsense-props-hint",
      text: `${total} notes scanned · ${blanks.length} blank · ${groups.length} name group${groups.length === 1 ? "" : "s"} that look like copies.`,
    });

    const openFile = (f: TFile) => {
      this.close();
      void this.app.workspace.getLeaf("tab").openFile(f);
    };

    c.createEl("div", { cls: "setting-item-heading", text: "Blank notes" });
    if (!blanks.length) c.createDiv({ cls: "gridsense-props-empty", text: "None." });
    if (blanks.length > 50)
      c.createDiv({
        cls: "gridsense-props-hint",
        text: `Showing the 50 most recent of ${blanks.length}. Use "Copy report" for the full list.`,
      });
    for (const b of [...blanks].sort((a, z) => z.file.stat.mtime - a.file.stat.mtime).slice(0, 50)) {
      new Setting(c)
        .setName(b.file.basename)
        .setDesc(
          `${b.reason === "empty" ? "Completely empty" : "Frontmatter only, no body"} · ${b.file.parent?.path || "/"} · modified ${new Date(b.file.stat.mtime).toLocaleString()}`
        )
        .addButton((btn) => btn.setButtonText("Open").onClick(() => openFile(b.file)));
    }

    c.createEl("div", { cls: "setting-item-heading", text: "Look-alike names" });
    if (!groups.length) c.createDiv({ cls: "gridsense-props-empty", text: "None." });
    for (const g of groups) {
      const item = c.createDiv({ cls: "gridsense-history-entry" });
      item.createDiv({ cls: "gridsense-history-label", text: g.stem });
      for (const f of g.files.sort((a, b) => a.stat.mtime - b.stat.mtime)) {
        const line = item.createDiv({ cls: "gridsense-history-change" });
        line.createSpan({ cls: "gridsense-history-file", text: f.basename });
        line.createSpan({
          cls: "gridsense-history-diff",
          text: `${f.stat.size}B · ${new Date(f.stat.mtime).toLocaleString()}`,
        });
        const btn = line.createEl("button", { cls: "gridsense-history-restore", text: "open" });
        btn.addEventListener("click", () => openFile(f));
      }
    }

    new Setting(c).addButton((b) =>
      b
        .setButtonText("Copy report")
        .setCta()
        .onClick(() => {
          const lines = [
            `GridSense scan — ${this.folder || "(vault)"} — ${new Date().toISOString()}`,
            `${total} notes, ${blanks.length} blank, ${groups.length} look-alike groups`,
            "",
            "Blank notes:",
            ...blanks.map(
              (b) => `  ${b.file.path} (${b.reason}, ${new Date(b.file.stat.mtime).toISOString()})`
            ),
            "",
            "Look-alike names:",
            ...groups.flatMap((g) => [
              `  ${g.stem}:`,
              ...g.files.map(
                (f) => `    ${f.path} (${f.stat.size}B, ${new Date(f.stat.mtime).toISOString()})`
              ),
            ]),
          ];
          void navigator.clipboard.writeText(lines.join("\n"));
          new Notice("GridSense: scan report copied");
        })
    );
  }
}
