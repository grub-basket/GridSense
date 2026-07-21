import { TFile } from "obsidian";

export type Scalar = string | number | boolean | null;
export type FmValue = Scalar | Scalar[];

export interface Row {
  file: TFile;
  fm: Record<string, unknown>;
  /** Lazily resolved heading-column values, keyed by heading name. */
  headings: Record<string, string>;
  /** Evaluated formula-column values, keyed by formula name. */
  formulas?: Record<string, string>;
}

export type ColumnKind = "file" | "prop" | "heading" | "formula";

export interface ColumnSpec {
  kind: ColumnKind;
  /** Property name, heading name, or "file". */
  key: string;
}

export function colId(c: ColumnSpec): string {
  return `${c.kind}:${c.key}`;
}

export interface CellRef {
  row: number;
  col: number;
}

export interface ChangeRecord {
  path: string;
  key: string;
  before: unknown;
  after: unknown;
}

export interface HistoryEntry {
  label: string;
  when: number;
  changes: ChangeRecord[];
}

export type SortDir = "asc" | "desc";

export interface FormulaSpec {
  /** Column title, also the default lookup property. */
  name: string;
  type: "xlookup" | "xmatch";
  /** Property on THIS row whose value we look up (defaults to name). */
  lookupProp: string;
  /** Folder whose notes are searched. */
  searchDir: string;
  /** Property matched against the lookup value in the searched notes. */
  matchProp: string;
  /** xlookup: property to return from the matched note… */
  returnProp?: string;
  /** …or a heading whose section body is returned instead (heading-mapping). */
  returnHeading?: string;
  /** Value shown when nothing matches. */
  notFound: string;
}

export interface FolderConfig {
  /** Extra heading-content columns for this folder scope. */
  headingColumns: string[];
  /** Hidden property columns. */
  hidden: string[];
  sort?: { key: string; dir: SortDir } | null;
  filter?: string;
  /** Per-column widths in px (keyed by colId). */
  widths?: Record<string, number>;
  wrap?: boolean;
  limit?: number;
  formulas?: FormulaSpec[];
  /** Display order of columns (colIds); unlisted columns keep natural order. */
  order?: string[];
  /** Display-name overrides for property columns (key → shown name). */
  rename?: Record<string, string>;
  /** Named snapshots of this config, applied via the columns manager. */
  views?: Record<string, Omit<FolderConfig, "views">>;
}

export interface GridSenseSettings {
  folders: Record<string, FolderConfig>;
  /** Show the heading name as the first line of heading-embed cells. */
  showHeadingNames: boolean;
  /** Replace Obsidian's native properties panel with the GridSense editor. */
  inlineProps: boolean;
}

export const DEFAULT_SETTINGS: GridSenseSettings = {
  folders: {},
  showHeadingNames: true,
  inlineProps: false,
};
