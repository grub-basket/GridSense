import { App, Notice, TFile } from "obsidian";
import { ChangeRecord, HistoryEntry } from "./types";

/** Render any frontmatter value for display/editing as a single-line string. */
export function valueToDisplay(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => valueToDisplay(x)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Parse a typed-in string back to a frontmatter value, shaped by what was
 * there before: lists stay lists (comma-split), numbers/booleans coerce when
 * they round-trip cleanly, empty string clears the key (null).
 */
export function parseInput(text: string, previous: unknown): unknown {
  const t = text.trim();
  if (t === "") return null;
  if (Array.isArray(previous)) {
    return t
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => coerceScalar(s));
  }
  if (typeof previous === "boolean") {
    if (/^(true|yes|1)$/i.test(t)) return true;
    if (/^(false|no|0)$/i.test(t)) return false;
  }
  if (typeof previous === "number") {
    const n = Number(t);
    if (!Number.isNaN(n)) return n;
  }
  return coerceScalar(t);
}

function coerceScalar(t: string): unknown {
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t)) && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** In-memory undo stack of grid write operations. */
export class EditEngine {
  history: HistoryEntry[] = [];

  /** onEntry receives every committed entry (including undos) for the
   * immortal on-disk log; the in-memory stack alone drives undo. */
  constructor(private app: App, private onEntry?: (entry: HistoryEntry) => void) {}

  /** Apply one batch of cell writes as a single undoable entry. */
  async apply(
    label: string,
    writes: { file: TFile; key: string; value: unknown }[]
  ): Promise<number> {
    const changes: ChangeRecord[] = [];
    for (const w of writes) {
      try {
        await this.app.fileManager.processFrontMatter(w.file, (fm) => {
          const before = fm[w.key];
          if (JSON.stringify(before ?? null) === JSON.stringify(w.value ?? null)) return;
          if (w.value === null || w.value === undefined) delete fm[w.key];
          else fm[w.key] = w.value;
          changes.push({ path: w.file.path, key: w.key, before: before ?? null, after: w.value });
        });
      } catch (e) {
        new Notice(`GridSense: failed to write ${w.file.basename}: ${String(e)}`);
      }
    }
    if (changes.length) {
      const entry: HistoryEntry = { label, when: Date.now(), changes };
      this.history.push(entry);
      this.onEntry?.(entry);
    }
    return changes.length;
  }

  async undo(): Promise<void> {
    const entry = this.history.pop();
    if (!entry) {
      new Notice("GridSense: nothing to undo");
      return;
    }
    let reverted = 0;
    const undone: ChangeRecord[] = [];
    for (const c of entry.changes) {
      const file = this.app.vault.getAbstractFileByPath(c.path);
      if (!(file instanceof TFile)) continue;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (c.before === null) delete fm[c.key];
        else fm[c.key] = c.before;
        reverted++;
        undone.push({ path: c.path, key: c.key, before: c.after, after: c.before });
      });
    }
    if (undone.length)
      this.onEntry?.({ label: `undo: ${entry.label}`, when: Date.now(), changes: undone });
    new Notice(`GridSense: undid "${entry.label}" (${reverted} cell${reverted === 1 ? "" : "s"})`);
  }
}
