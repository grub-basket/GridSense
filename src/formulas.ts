import { App, TFile, TFolder } from "obsidian";
import { FormulaSpec, Row } from "./types";
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
