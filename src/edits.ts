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

interface UiAction {
  kind: "ui";
  label: string;
  undoFn: () => Promise<void>;
  redoFn: () => Promise<void>;
}

type StackEntry = { kind: "fm"; entry: HistoryEntry } | UiAction;

/** In-memory undo/redo stack: frontmatter writes AND UI actions (column
 * hide/remove) share one stack, so ⌘Z walks back whatever you did last. */
export class EditEngine {
  private undoStack: StackEntry[] = [];
  private redoStack: StackEntry[] = [];

  /** onEntry receives every committed frontmatter entry (including undos and
   * redos) for the immortal on-disk log; UI actions are not logged there. */
  constructor(private app: App, private onEntry?: (entry: HistoryEntry) => void) {}

  /** Record an undoable UI action (e.g. hiding a column). */
  pushUi(label: string, undoFn: () => Promise<void>, redoFn: () => Promise<void>) {
    this.undoStack.push({ kind: "ui", label, undoFn, redoFn });
    this.redoStack = [];
  }

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
      this.undoStack.push({ kind: "fm", entry });
      this.redoStack = [];
      this.onEntry?.(entry);
    }
    return changes.length;
  }

  async undo(): Promise<void> {
    const top = this.undoStack.pop();
    if (!top) {
      new Notice("GridSense: nothing to undo");
      return;
    }
    if (top.kind === "ui") {
      await top.undoFn();
      this.redoStack.push(top);
      new Notice(`GridSense: undid "${top.label}"`);
      return;
    }
    const entry = top.entry;
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
    this.redoStack.push(top);
    if (undone.length)
      this.onEntry?.({ label: `undo: ${entry.label}`, when: Date.now(), changes: undone });
    new Notice(`GridSense: undid "${entry.label}" (${reverted} cell${reverted === 1 ? "" : "s"})`);
  }

  async redo(): Promise<void> {
    const top = this.redoStack.pop();
    if (!top) {
      new Notice("GridSense: nothing to redo");
      return;
    }
    if (top.kind === "ui") {
      await top.redoFn();
      this.undoStack.push(top);
      new Notice(`GridSense: redid "${top.label}"`);
      return;
    }
    const entry = top.entry;
    let reapplied = 0;
    const redone: ChangeRecord[] = [];
    for (const c of entry.changes) {
      const file = this.app.vault.getAbstractFileByPath(c.path);
      if (!(file instanceof TFile)) continue;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (c.after === null || c.after === undefined) delete fm[c.key];
        else fm[c.key] = c.after;
        reapplied++;
        redone.push(c);
      });
    }
    this.undoStack.push(top);
    if (redone.length)
      this.onEntry?.({ label: `redo: ${entry.label}`, when: Date.now(), changes: redone });
    new Notice(`GridSense: redid "${entry.label}" (${reapplied} cell${reapplied === 1 ? "" : "s"})`);
  }
}
