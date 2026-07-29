import { App, TFile, TFolder } from "obsidian";
import { Condition, FormulaSpec, Row } from "./types";
import { extractHeadingSection } from "./headings";
import { valueToDisplay } from "./edits";

function filesInDir(app: App, dirPath: string): TFile[] {
  const root = app.vault.getAbstractFileByPath(dirPath === "" ? "/" : dirPath);
  const out: TFile[] = [];
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && child.extension === "md") out.push(child);
    }
  };
  if (root instanceof TFolder) walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

interface FormulaIndex {
  /** lookup value (lowercased display) → first matching file */
  byValue: Map<string, { file: TFile; position: number }>;
}

function buildIndex(app: App, spec: FormulaSpec): FormulaIndex {
  const byValue = new Map<string, { file: TFile; position: number }>();
  const files = filesInDir(app, spec.searchDir);
  files.forEach((file, i) => {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const raw = fm[spec.matchProp];
    if (raw === undefined || raw === null) return;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      const key = valueToDisplay(v).toLowerCase();
      if (key && !byValue.has(key)) byValue.set(key, { file, position: i + 1 });
    }
  });
  return { byValue };
}

/** Compare one row's property against a condition. */
export function matches(row: Row, c: Condition): boolean {
  const raw = row.fm[c.prop];
  const empty = raw === undefined || raw === null || raw === "" ||
    (Array.isArray(raw) && raw.length === 0);
  if (c.op === "empty") return empty;
  if (c.op === "not-empty") return !empty;
  const left = valueToDisplay(raw);
  const right = c.value ?? "";
  const ln = Number(left);
  const rn = Number(right);
  const numeric = left !== "" && right !== "" && !Number.isNaN(ln) && !Number.isNaN(rn);
  switch (c.op) {
    case "=":
      return numeric ? ln === rn : left.toLowerCase() === right.toLowerCase();
    case "!=":
      return numeric ? ln !== rn : left.toLowerCase() !== right.toLowerCase();
    case ">":
      return numeric ? ln > rn : left > right;
    case "<":
      return numeric ? ln < rn : left < right;
    case ">=":
      return numeric ? ln >= rn : left >= right;
    case "<=":
      return numeric ? ln <= rn : left <= right;
    case "contains":
      return left.toLowerCase().includes(right.toLowerCase());
    default:
      return false;
  }
}

/** Rows that COUNTIF/SUMIF scan: another folder if set, else the grid itself. */
function scopeRows(app: App, spec: FormulaSpec, rows: Row[]): Row[] {
  if (!spec.countDir) return rows;
  return filesInDir(app, spec.countDir).map((file) => ({
    file,
    fm: { ...(app.metadataCache.getFileCache(file)?.frontmatter ?? {}) },
    headings: {},
  }));
}

/**
 * Evaluate every formula column for the given rows, writing results into
 * row.formulas[spec.name]. XLOOKUP returns a property (or a heading-section
 * body — the heading-mapping case) from the first note in searchDir whose
 * matchProp equals this row's lookup value. XMATCH returns the 1-based
 * position of that note in the searched folder.
 */
export async function evaluateFormulas(
  app: App,
  specs: FormulaSpec[],
  rows: Row[]
): Promise<void> {
  for (const spec of specs) {
    // Excel-style formulas that don't need a lookup index.
    if (spec.type !== "xlookup" && spec.type !== "xmatch") {
      const conds = spec.conditions ?? [];
      if (spec.type === "countif" || spec.type === "sumif") {
        // Aggregates: one value for the whole column (like a spreadsheet's
        // COUNTIF over a range), computed once and shown on every row.
        const pool = scopeRows(app, spec, rows);
        const hits = pool.filter((r) => conds.every((c) => matches(r, c)));
        let out: string;
        if (spec.type === "countif") out = String(hits.length);
        else {
          const total = hits.reduce((sum, r) => {
            const n = Number(valueToDisplay(r.fm[spec.sumProp ?? ""]));
            return sum + (Number.isNaN(n) ? 0 : n);
          }, 0);
          out = String(Math.round(total * 1000) / 1000);
        }
        for (const row of rows) {
          row.formulas = row.formulas ?? {};
          row.formulas[spec.name] = out;
        }
        continue;
      }
      for (const row of rows) {
        row.formulas = row.formulas ?? {};
        if (spec.type === "concat") {
          const sep = spec.separator ?? " ";
          row.formulas[spec.name] = (spec.parts ?? [])
            .map((p) => {
              // Quoted parts are literals; file.* are pseudo-properties;
              // everything else is a frontmatter property name.
              if (/^(["']).*\1$/.test(p)) return p.slice(1, -1);
              if (p === "file.basename" || p === "file.name") return row.file.basename;
              if (p === "file.path") return row.file.path;
              if (p === "file.folder") return row.file.parent?.path ?? "";
              return valueToDisplay(row.fm[p]);
            })
            .filter((v) => v !== "")
            .join(sep);
        } else if (spec.type === "if") {
          const ok = conds.length > 0 && conds.every((c) => matches(row, c));
          row.formulas[spec.name] = ok ? spec.thenValue ?? "true" : spec.elseValue ?? "";
        } else if (spec.type === "and") {
          const ok = conds.length > 0 && conds.every((c) => matches(row, c));
          row.formulas[spec.name] = ok ? spec.thenValue ?? "true" : spec.elseValue ?? "false";
        } else if (spec.type === "ifs") {
          // First matching condition wins; notFound is the fallback.
          const hit = conds.find((c) => matches(row, c));
          row.formulas[spec.name] = hit ? hit.then ?? "true" : spec.notFound ?? "";
        }
      }
      continue;
    }
    const index = buildIndex(app, spec);
    const headingCache = new Map<string, string>();
    for (const row of rows) {
      row.formulas = row.formulas ?? {};
      const lookupRaw = row.fm[spec.lookupProp || spec.name];
      const key = valueToDisplay(lookupRaw).toLowerCase();
      const hit = key ? index.byValue.get(key) : undefined;
      if (!hit) {
        row.formulas[spec.name] = spec.notFound;
        continue;
      }
      if (spec.type === "xmatch") {
        row.formulas[spec.name] = String(hit.position);
        continue;
      }
      if (spec.returnHeading) {
        const cacheKey = `${hit.file.path}#${spec.returnHeading}`;
        let body = headingCache.get(cacheKey);
        if (body === undefined) {
          body = await extractHeadingSection(app, hit.file, spec.returnHeading);
          headingCache.set(cacheKey, body);
        }
        row.formulas[spec.name] = body || spec.notFound;
      } else if (spec.returnProp) {
        const fm = app.metadataCache.getFileCache(hit.file)?.frontmatter ?? {};
        const v = fm[spec.returnProp];
        row.formulas[spec.name] =
          v === undefined || v === null ? spec.notFound : valueToDisplay(v);
      } else {
        row.formulas[spec.name] = hit.file.basename;
      }
    }
  }
}
