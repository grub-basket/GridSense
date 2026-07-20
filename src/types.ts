import { TFile } from "obsidian";

export type Scalar = string | number | boolean | null;
export type FmValue = Scalar | Scalar[];

export interface Row {
  file: TFile;
  fm: Record<string, unknown>;
  /** Lazily resolved heading-column values, keyed by heading name. */
  headings: Record<string, string>;
}

export type ColumnKind = "file" | "prop" | "heading";

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

export interface FolderConfig {
  /** Extra heading-content columns for this folder scope. */
  headingColumns: string[];
  /** Hidden property columns. */
  hidden: string[];
}

export interface GridSenseSettings {
  folders: Record<string, FolderConfig>;
}

export const DEFAULT_SETTINGS: GridSenseSettings = { folders: {} };
