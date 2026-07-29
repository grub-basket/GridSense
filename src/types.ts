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

export type FormulaType =
  | "xlookup"
  | "xmatch"
  | "countif"
  | "sumif"
  | "concat"
  | "if"
  | "ifs"
  | "and";

export interface Condition {
  /** Property on the row being evaluated. */
  prop: string;
  op: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "empty" | "not-empty";
  value: string;
  /** Result for IFS (ignored by other formula types). */
  then?: string;
}

export interface FormulaSpec {
  /** Column title, also the default lookup property. */
  name: string;
  type: FormulaType;
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
  /** COUNTIF/SUMIF/IF/IFS/AND: conditions evaluated against each row. */
  conditions?: Condition[];
  /** SUMIF: property to total. COUNTIF ignores it. */
  sumProp?: string;
  /** CONCAT: properties joined, and the separator between them. */
  parts?: string[];
  separator?: string;
  /** IF/AND: values for the true / false branches. */
  thenValue?: string;
  elseValue?: string;
  /** Scope for COUNTIF/SUMIF: which folder's notes to count (default: grid). */
  countDir?: string;
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
  /** Max auto-computed column width in px for this grid (drag-resize wins). */
  widthCap?: number;
  /** Freeze the first N columns / rows in place while scrolling. */
  freezeCols?: number;
  freezeRows?: number;
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
  /** Row cap applied to grids with no per-folder limit (0 = unlimited). */
  defaultRowLimit: number;
  /** Mirror per-grid config into a vault file so it syncs with the notes. */
  syncConfigFile: boolean;
  /** Vault-relative path of that file. */
  configFilePath: string;
  /** Folder that row deletes move notes into (undoable, browsable). */
  trashFolder: string;
  /** Per-note overrides for the properties takeover (path → on/off). */
  inlinePropsOverrides: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: GridSenseSettings = {
  folders: {},
  showHeadingNames: true,
  inlineProps: false,
  defaultRowLimit: 0,
  syncConfigFile: false,
  configFilePath: "gridsense-config.json",
  trashFolder: "GridSense Trash",
  inlinePropsOverrides: {},
};
