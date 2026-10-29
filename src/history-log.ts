import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import { ChangeRecord, HistoryEntry, KeyOrderRecord } from "./types";
import { valueToDisplay } from "./edits";
import { revertKeyOrder } from "./property-order";

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

/** Comparable form of a property's state; absent and empty differ. */
const sig = (present: boolean, v: unknown) => (present ? "v:" + JSON.stringify(v ?? null) : "absent");

export interface RevertResult {
  /** Cells / notes put back. */
  reverted: number;
  /** Edited again since this entry, so left alone. */
  changedSince: number;
  /** Renamed, moved or deleted since. */
  missing: number;
  /** What the revert itself did, for the log (null when nothing changed). */
  entry: HistoryEntry | null;
}

/**
 * Undo a whole logged operation, long after the in-memory ⌘Z stack is gone
 * (another session, a restart). Each cell or note is only put back when it
 * still holds what this entry wrote; anything edited since is skipped rather
 * than overwritten. The revert is itself an entry, so it can be undone too.
 */
export async function revertEntry(app: App, entry: HistoryEntry): Promise<RevertResult> {
  const undone: ChangeRecord[] = [];
  const orders: KeyOrderRecord[] = [];
  let changedSince = 0;
  let missing = 0;
  // Last write wins within one entry, so walk it backwards.
  for (const c of [...entry.changes].reverse()) {
    const file = app.vault.getAbstractFileByPath(c.path);
    if (!(file instanceof TFile)) {
      missing++;
      continue;
    }
    try {
      await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        const present = Object.prototype.hasOwnProperty.call(fm, c.key);
        const now = sig(present, fm[c.key]);
        // Already back (a "restore", or an undo in another session): nothing to do.
        if (now === sig(c.before !== undefined, c.before)) return;
        if (now !== sig(c.after !== undefined, c.after)) {
          changedSince++;
          return;
        }
        if (c.before === undefined) delete fm[c.key];
        else fm[c.key] = c.before;
        undone.push({ path: c.path, key: c.key, before: c.after, after: c.before });
      });
    } catch {
      missing++;
    }
  }
  for (const o of entry.orders ?? []) {
    const file = app.vault.getAbstractFileByPath(o.path);
    if (!(file instanceof TFile)) {
      missing++;
      continue;
    }
    try {
      const r = await revertKeyOrder(app, file, o.after, o.before);
      if (r === "changed") changedSince++;
      else if (r === "done") orders.push({ path: o.path, before: o.after, after: o.before });
    } catch {
      missing++;
    }
  }
  const reverted = undone.length + orders.length;
  return {
    reverted,
    changedSince,
    missing,
    entry: reverted
      ? { label: `undo: ${entry.label}`, when: Date.now(), changes: undone, ...(orders.length ? { orders } : {}) }
      : null,
  };
}

const SHOW_BATCH = 100;

export interface HistoryFilter {
  /** Only entries touching this note path. */
  path?: string;
  /** Only entries touching this property key. */
  key?: string;
  label: string;
}

/** Narrow a log to the changes matching a filter (row / column / cell view). */
export function filterHistory(entries: HistoryEntry[], f: HistoryFilter): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const e of entries) {
    const changes = e.changes.filter(
      (c) => (!f.path || c.path === f.path) && (!f.key || c.key === f.key)
    );
    // Reorders change no values, so they only show in row (note) views.
    const orders = f.key ? [] : (e.orders ?? []).filter((o) => !f.path || o.path === f.path);
    if (changes.length || orders.length) out.push({ ...e, changes, orders });
  }
  return out;
}

export class HistoryLogModal extends Modal {
  private shown = SHOW_BATCH;

  constructor(
    app: App,
    private folderPath: string,
    private entries: HistoryEntry[],
    private scopeLabel?: string,
    private onRestore?: (change: { path: string; key: string; value: unknown }) => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("gridsense-history-modal");
    this.titleEl.setText(
      this.scopeLabel
        ? `History — ${this.scopeLabel}`
        : `Edit history — ${this.folderPath || "(vault)"}`
    );
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
    const reorders = this.entries.reduce((n, e) => n + (e.orders?.length ?? 0), 0);
    c.createDiv({
      cls: "gridsense-props-hint",
      text: `${this.entries.length} operations · ${total} cell writes${reorders ? ` · ${reorders} note reorders` : ""} · newest first · log survives tab close and restarts${this.scopeLabel ? "" : " · \"undo this\" puts back a whole operation, skipping anything edited since"}`,
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
      // Whole-operation undo only in the full log: a scoped view shows part
      // of an entry, and undoing "this" there would be ambiguous.
      // Not for added rows: the log holds their properties but creating the
      // note itself was a ⌘Z-only action, so "undo" would blank the note and
      // leave it. Delete the row (it goes to the GridSense trash) instead.
      if (!this.scopeLabel && !/^add row /.test(e.label)) {
        const undo = head.createEl("button", { cls: "gridsense-history-restore", text: "undo this" });
        undo.setAttr("title", "Put back everything this operation changed, except what's been edited since");
        undo.addEventListener("click", () => void this.undoEntry(e, undo));
      }
      for (const o of e.orders ?? []) {
        const line = item.createDiv({ cls: "gridsense-history-change" });
        line.createSpan({ cls: "gridsense-history-file", text: o.path.split("/").pop() ?? o.path });
        line.createSpan({ cls: "gridsense-history-key", text: "property order" });
        line.createSpan({
          cls: "gridsense-history-diff",
          text: `${o.before.join(", ") || "∅"} → ${o.after.join(", ") || "∅"}`,
        });
      }
      for (const ch of e.changes) {
        const line = item.createDiv({ cls: "gridsense-history-change" });
        line.createSpan({ cls: "gridsense-history-file", text: ch.path.split("/").pop() ?? ch.path });
        line.createSpan({ cls: "gridsense-history-key", text: ch.key });
        line.createSpan({
          cls: "gridsense-history-diff",
          text: `${valueToDisplay(ch.before) || "∅"} → ${valueToDisplay(ch.after) || "∅"}`,
        });
        if (this.onRestore) {
          // Restore the BEFORE value of this change — the point of looking at
          // history is usually "put that back".
          const btn = line.createEl("button", {
            cls: "gridsense-history-restore",
            text: "restore",
          });
          btn.setAttr("title", `Set ${ch.key} back to "${valueToDisplay(ch.before) || "(empty)"}"`);
          btn.addEventListener("click", async () => {
            await this.onRestore?.({ path: ch.path, key: ch.key, value: ch.before });
            btn.setText("restored");
            btn.addClass("gridsense-history-restored");
          });
        }
      }
    }
    if (this.entries.length > this.shown) {
      this.renderMore(c);
    }
  }

  private async undoEntry(e: HistoryEntry, btn: HTMLButtonElement) {
    btn.disabled = true;
    btn.setText("undoing…");
    let r: RevertResult;
    try {
      r = await revertEntry(this.app, e);
    } catch (err) {
      new Notice(`GridSense: undo failed: ${String(err)}`);
      btn.disabled = false;
      btn.setText("undo this");
      return;
    }
    if (r.entry) {
      await appendHistory(this.app, this.folderPath, r.entry);
      // Newest first: the revert shows at the top, with its own "undo this".
      this.entries = [...this.entries, r.entry];
    }
    const extra = [
      r.changedSince ? `${r.changedSince} edited since, left alone` : "",
      r.missing ? `${r.missing} in notes that were moved or deleted` : "",
    ].filter(Boolean);
    new Notice(
      r.reverted
        ? `GridSense: undid "${e.label}" (${r.reverted} change${r.reverted === 1 ? "" : "s"})${extra.length ? " · " + extra.join(" · ") : ""}`
        : `GridSense: nothing to undo for "${e.label}"${extra.length ? " · " + extra.join(" · ") : " (already undone)"}`,
      8000
    );
    this.renderBody();
  }

  private renderMore(c: HTMLElement) {
    const more = c.createEl("button", {
      text: `Show ${Math.min(SHOW_BATCH, this.entries.length - this.shown)} more…`,
    });
    more.addEventListener("click", () => {
      this.shown += SHOW_BATCH;
      this.renderBody();
    });
  }
}
