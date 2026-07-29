import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type GridSensePlugin from "./main";

/**
 * GridSense's own trash: deleting a row moves the note into a normal vault
 * folder instead of Obsidian's trash, which keeps the delete undoable (⌘Z
 * moves it straight back) and browsable. Emptying it hands everything to
 * Obsidian's trash, honouring the user's "Deleted files" setting.
 *
 * Moves use vault.rename, NOT fileManager.renameFile: links pointing at the
 * note must keep their original target so a restore heals them, rather than
 * being rewritten to point into the trash folder.
 */
export class GridTrash {
  constructor(private app: App, private plugin: GridSensePlugin) {}

  folderPath(): string {
    return normalizePath(
      (this.plugin.settings.trashFolder || "GridSense Trash").trim().replace(/^\/+|\/+$/g, "") ||
        "GridSense Trash"
    );
  }

  private async ensureFolder(): Promise<void> {
    const p = this.folderPath();
    if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p);
  }

  private freePath(dir: string, base: string, ext: string): string {
    let candidate = `${dir}/${base}.${ext}`;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(candidate))
      candidate = `${dir}/${base} (${n++}).${ext}`;
    return normalizePath(candidate);
  }

  /**
   * Move a note into the GridSense trash.
   * @returns the trashed path plus a restore function, or null on failure.
   */
  async trash(
    file: TFile
  ): Promise<{ from: string; to: string; restore: () => Promise<void> } | null> {
    const from = file.path;
    try {
      await this.ensureFolder();
      const to = this.freePath(this.folderPath(), file.basename, file.extension);
      await this.app.vault.rename(file, to);
      return {
        from,
        to,
        restore: async () => {
          const moved = this.app.vault.getAbstractFileByPath(to);
          if (!(moved instanceof TFile)) {
            new Notice(`GridSense: "${to}" is no longer in the trash — can't restore`);
            return;
          }
          const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
          if (dir && !this.app.vault.getAbstractFileByPath(dir))
            await this.app.vault.createFolder(dir).catch(() => undefined);
          const target = this.app.vault.getAbstractFileByPath(from)
            ? this.freePath(
                dir,
                from.slice(dir ? dir.length + 1 : 0).replace(/\.[^.]+$/, ""),
                moved.extension
              )
            : from;
          await this.app.vault.rename(moved, target);
        },
      };
    } catch (e) {
      new Notice(`GridSense: couldn't move "${file.basename}" to the GridSense trash — ${String(e)}`);
      return null;
    }
  }

  list(): TFile[] {
    const folder = this.app.vault.getAbstractFileByPath(this.folderPath());
    if (!(folder instanceof TFolder)) return [];
    const out: TFile[] = [];
    const walk = (f: TFolder) => {
      for (const c of f.children) {
        if (c instanceof TFolder) walk(c);
        else if (c instanceof TFile) out.push(c);
      }
    };
    walk(folder);
    return out;
  }

  /** Hand everything in the GridSense trash to Obsidian's trash. */
  async empty(): Promise<number> {
    const files = this.list();
    let moved = 0;
    for (const f of files) {
      try {
        await this.app.fileManager.trashFile(f);
        moved++;
      } catch (e) {
        new Notice(`GridSense: couldn't empty "${f.basename}" — ${String(e)}`);
      }
    }
    return moved;
  }
}
