import { App, Notice, TAbstractFile, TFile, debounce, normalizePath } from "obsidian";
import type GridSensePlugin from "./main";
import { FolderConfig } from "./types";

interface ConfigFilePayload {
  gridsense: string;
  updatedAt: string;
  folders: Record<string, FolderConfig>;
}

/**
 * Optional vault-side storage for per-grid configuration.
 *
 * Plugin settings normally live in `.obsidian/plugins/gridsense/data.json`,
 * which only travels if you sync your `.obsidian` folder. When this is on we
 * mirror the per-folder grid configs (columns, sort, widths, views, formulas…)
 * into a normal vault file so they ride along with the notes themselves —
 * across Obsidian Sync, git, iCloud, Dropbox, whatever moves the vault.
 *
 * data.json stays the source for global settings and remains a valid fallback;
 * the vault file wins on load when present, and external edits (a sync landing
 * a newer copy) are picked up live.
 */
export class ConfigFileStore {
  private writing = false;
  private lastWritten = "";

  constructor(private app: App, private plugin: GridSensePlugin) {}

  path(): string {
    const raw = (this.plugin.settings.configFilePath || "gridsense-config.json").trim();
    return normalizePath(raw.replace(/^\/+/, ""));
  }

  /** Watch for external changes (sync/git landing a newer config). */
  register() {
    const onChange = debounce(
      (file: TAbstractFile) => {
        if (!this.plugin.settings.syncConfigFile) return;
        if (file.path !== this.path() || this.writing) return;
        void this.load(true);
      },
      400,
      true
    );
    this.plugin.registerEvent(this.app.vault.on("modify", onChange));
    this.plugin.registerEvent(this.app.vault.on("create", onChange));
  }

  /**
   * Read folder configs from the vault file into settings.
   * @param refresh repaint open grids afterwards (external-change path).
   */
  async load(refresh = false): Promise<boolean> {
    if (!this.plugin.settings.syncConfigFile) return false;
    try {
      const p = this.path();
      const file = this.app.vault.getAbstractFileByPath(p);
      if (!(file instanceof TFile)) return false;
      const text = await this.app.vault.read(file);
      if (text === this.lastWritten) return false; // our own write echoing back
      const payload = JSON.parse(text) as Partial<ConfigFilePayload>;
      if (!payload || typeof payload.folders !== "object" || payload.folders === null) return false;
      this.plugin.settings.folders = payload.folders as Record<string, FolderConfig>;
      this.lastWritten = text;
      await this.plugin.saveData(this.plugin.settings); // keep data.json in step
      if (refresh) {
        this.plugin.refreshOpenGrids();
        new Notice("GridSense: grid config reloaded from the vault file");
      }
      return true;
    } catch (e) {
      new Notice(`GridSense: couldn't read grid config file — ${String(e)}`);
      return false;
    }
  }

  /** Debounced mirror of folder configs into the vault file. */
  save = debounce(() => void this.saveNow(), 700, true);

  async saveNow(): Promise<void> {
    if (!this.plugin.settings.syncConfigFile) return;
    const payload: ConfigFilePayload = {
      gridsense: this.plugin.manifest.version,
      updatedAt: new Date().toISOString(),
      folders: this.plugin.settings.folders,
    };
    const text = JSON.stringify(payload, null, 2);
    const p = this.path();
    this.writing = true;
    try {
      const existing = this.app.vault.getAbstractFileByPath(p);
      if (existing instanceof TFile) {
        if ((await this.app.vault.read(existing)) === text) return;
        await this.app.vault.modify(existing, text);
      } else {
        const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
        if (dir && !this.app.vault.getAbstractFileByPath(dir))
          await this.app.vault.createFolder(dir).catch(() => undefined);
        await this.app.vault.create(p, text);
      }
      this.lastWritten = text;
    } catch (e) {
      new Notice(`GridSense: couldn't write grid config file — ${String(e)}`);
    } finally {
      // Let the vault's own modify event settle before accepting external ones.
      window.setTimeout(() => (this.writing = false), 600);
    }
  }
}
