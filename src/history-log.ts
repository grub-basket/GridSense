import { App, Modal, normalizePath } from "obsidian";
import { HistoryEntry } from "./types";
import { valueToDisplay } from "./edits";

export function scopeSlug(folderPath: string): string {
  return folderPath.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "vault";
}

function logPath(app: App, folderPath: string): string {
  return normalizePath(
    `${app.vault.configDir}/plugins/gridsense/history/${scopeSlug(folderPath)}.jsonl`
  );
}

/**
 * Immortal append-only edit log, one JSONL file per grid scope. Unlike the
 * in-memory undo stack (which dies with the tab), this records every write —
 * including undos — forever. Append failures never block the edit itself.
 */
export async function appendHistory(
  app: App,
  folderPath: string,
  entry: HistoryEntry
): Promise<void> {
  try {
    const adapter = app.vault.adapter;
    const dir = normalizePath(`${app.vault.configDir}/plugins/gridsense/history`);
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.append(logPath(app, folderPath), JSON.stringify(entry) + "\n");
  } catch {
    // Logging must never break an edit.
  }
}

export async function readHistory(app: App, folderPath: string): Promise<HistoryEntry[]> {
  try {
    const p = logPath(app, folderPath);
    if (!(await app.vault.adapter.exists(p))) return [];
    const text = await app.vault.adapter.read(p);
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as HistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is HistoryEntry => !!e);
  } catch {
    return [];
  }
}

const SHOW_BATCH = 100;

export class HistoryLogModal extends Modal {
  private shown = SHOW_BATCH;

  constructor(app: App, private folderPath: string, private entries: HistoryEntry[]) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("gridsense-history-modal");
    this.titleEl.setText(`Edit history — ${this.folderPath || "(vault)"}`);
    this.renderBody();
  }

  private renderBody() {
    const c = this.contentEl;
    c.empty();
    if (!this.entries.length) {
      c.createDiv({ cls: "gridsense-props-empty", text: "No recorded edits yet." });
      return;
    }
    const total = this.entries.reduce((n, e) => n + e.changes.length, 0);
    c.createDiv({
      cls: "gridsense-props-hint",
      text: `${this.entries.length} operations · ${total} cell writes · newest first · log survives tab close and restarts`,
    });
    const list = c.createDiv({ cls: "gridsense-history-list" });
    const newest = [...this.entries].reverse().slice(0, this.shown);
    for (const e of newest) {
      const item = list.createDiv({ cls: "gridsense-history-entry" });
      const head = item.createDiv({ cls: "gridsense-history-head" });
      head.createSpan({ cls: "gridsense-history-label", text: e.label });
      head.createSpan({
        cls: "gridsense-history-when",
        text: new Date(e.when).toLocaleString(),
      });
      for (const ch of e.changes) {
        const line = item.createDiv({ cls: "gridsense-history-change" });
        line.createSpan({ cls: "gridsense-history-file", text: ch.path.split("/").pop() ?? ch.path });
        line.createSpan({ cls: "gridsense-history-key", text: ch.key });
        line.createSpan({
          cls: "gridsense-history-diff",
          text: `${valueToDisplay(ch.before) || "∅"} → ${valueToDisplay(ch.after) || "∅"}`,
        });
      }
    }
    if (this.entries.length > this.shown) {
      const more = c.createEl("button", {
        text: `Show ${Math.min(SHOW_BATCH, this.entries.length - this.shown)} more…`,
      });
      more.addEventListener("click", () => {
        this.shown += SHOW_BATCH;
        this.renderBody();
      });
    }
  }
}
