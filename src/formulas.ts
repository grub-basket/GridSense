import { App, TFile, TFolder } from "obsidian";
import { Condition, FormulaSpec, Row } from "./types";
import { extractHeadingSection } from "./headings";
import { daysAgo, isMetaDate, metaDisplay, metaRaw, parseDateOperand } from "./file-meta";
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

/**
 * Resolve a condition's left-hand side. `file.<key>` reads file metadata
 * (modified/created/size/extension/folder/name/path); anything else is a
 * frontmatter property.
 */
function conditionOperand(row: Row, prop: string): { raw: unknown; stamp: number | null } {
  if (!prop.startsWith("file.")) return { raw: row.fm[prop], stamp: null };
  const key = prop.slice(5);
  if (key === "name") return { raw: row.file.basename, stamp: null };
  if (key === "path") return { raw: row.file.path, stamp: null };
  const value = metaRaw(row.file, key);
  return { raw: isMetaDate(key) ? metaDisplay(row.file, key) : value,
    stamp: isMetaDate(key) ? (value as number) : null };
}

/** Compare one row's property against a condition. */
export function matches(row: Row, c: Condition): boolean {
  const operand = conditionOperand(row, c.prop);
  if (c.op === "last-days" || c.op === "after" || c.op === "before") {
    // File timestamps first; failing that, a frontmatter value that parses as a
    // date (so `due before 2026-09-01` works, not just `file.mtime`).
    const stamp = operand.stamp ?? parseDateOperand(valueToDisplay(operand.raw));
    if (stamp === null) return false;
    return matchesDate(stamp, c.op, c.value ?? "");
  }
  const raw = operand.raw;
  const empty = raw === undefined || raw === null || raw === "" ||
    (Array.isArray(raw) && raw.length === 0);
  if (c.op === "empty") return empty;
  if (c.op === "not-empty") return !empty;
  return matchesText(valueToDisplay(raw), c.op, c.value ?? "");
}

/**
 * The scalar half of `matches`: compare one display string against an operator
 * and operand. Numeric when both sides parse as numbers, case-insensitive
 * otherwise. Shared with the per-column filters, which work on cell text rather
 * than raw frontmatter. `empty`/`not-empty` are the caller's job — emptiness
 * depends on the source shape (an empty array isn't an empty string).
 */
/**
 * Date comparison for the temporal operators. "in the last N days" counts from
 * local midnight N days back, so it means whole days rather than a rolling
 * N×24h window that drifts through the day.
 */
export function matchesDate(stamp: number, op: Condition["op"], value: string): boolean {
  if (op === "last-days") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return false;
    return stamp >= daysAgo(n);
  }
  const at = parseDateOperand(value);
  if (at === null) return false;
  // "before 2026-08-01" means strictly before that day starts; "after" means
  // from the END of that day, so neither silently includes the boundary day.
  return op === "after" ? stamp >= at + 86400000 : stamp < at;
}

export function matchesText(left: string, op: Condition["op"], right: string): boolean {
  const ln = Number(left);
  const rn = Number(right);
  const numeric = left !== "" && right !== "" && !Number.isNaN(ln) && !Number.isNaN(rn);
  switch (op) {
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
