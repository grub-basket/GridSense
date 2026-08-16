import { TFile } from "obsidian";

/**
 * File metadata as first-class columns: modified/created dates, size, extension
 * and folder. Making them columns (rather than a bolted-on filter) means sorting,
 * the per-column filter dropdowns and the stacked conditions all work on them
 * with no extra code.
 */

export type MetaType = "date" | "number" | "text";

export interface MetaColumn {
  key: string;
  label: string;
  type: MetaType;
}

export const META_COLUMNS: MetaColumn[] = [
  { key: "mtime", label: "Modified", type: "date" },
  { key: "ctime", label: "Created", type: "date" },
  { key: "size", label: "Size", type: "number" },
  { key: "ext", label: "Extension", type: "text" },
  { key: "folder", label: "Folder", type: "text" },
];

export function metaColumn(key: string): MetaColumn | undefined {
  return META_COLUMNS.find((m) => m.key === key);
}

export function isMetaDate(key: string): boolean {
  return metaColumn(key)?.type === "date";
}

/**
 * The comparable value: epoch millis for dates, bytes for size, the string
 * itself for text. Sorting and date conditions use this, never the display text.
 */
export function metaRaw(file: TFile, key: string): number | string {
  switch (key) {
    case "mtime":
      return file.stat.mtime;
    case "ctime":
      return file.stat.ctime;
    case "size":
      return file.stat.size;
    case "ext":
      return file.extension;
    case "folder":
      return file.parent?.path === "/" ? "" : (file.parent?.path ?? "");
    default:
      return "";
  }
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Display text. Dates are written YYYY-MM-DD HH:MM so they sort and compare
 * correctly as plain strings too — the per-column filter's value list is text.
 */
export function metaDisplay(file: TFile, key: string): string {
  const raw = metaRaw(file, key);
  if (isMetaDate(key)) {
    const d = new Date(raw as number);
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  if (key === "size") {
    const b = raw as number;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }
  return String(raw);
}

/** Local midnight N days ago — the boundary for "in the last N days". */
export function daysAgo(n: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

/**
 * Parse a date operand. Accepts YYYY-MM-DD (interpreted as local midnight) and
 * anything else Date understands; returns null when it isn't a date at all, so
 * callers can decline rather than compare against NaN.
 */
export function parseDateOperand(text: string): number | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3]).getTime();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
