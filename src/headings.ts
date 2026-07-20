import { App, TFile } from "obsidian";

/**
 * Extract the body text under a heading (until the next heading of the same
 * or a higher level). Case-insensitive match on heading text. Returns "" if
 * the heading isn't present.
 */
export async function extractHeadingSection(
  app: App,
  file: TFile,
  heading: string
): Promise<string> {
  const cache = app.metadataCache.getFileCache(file);
  const headings = cache?.headings ?? [];
  const target = heading.trim().toLowerCase();
  const idx = headings.findIndex((h) => h.heading.trim().toLowerCase() === target);
  if (idx === -1) return "";
  const start = headings[idx];
  let endLine = Infinity;
  for (let i = idx + 1; i < headings.length; i++) {
    if (headings[i].level <= start.level) {
      endLine = headings[i].position.start.line;
      break;
    }
  }
  const text = await app.vault.cachedRead(file);
  const lines = text.split("\n");
  const body = lines.slice(start.position.start.line + 1, Math.min(endLine, lines.length));
  return body.join("\n").trim();
}

/** Union of all heading names in the given files (for the add-column suggester). */
export function allHeadings(app: App, files: TFile[]): string[] {
  const seen = new Map<string, string>();
  for (const f of files) {
    for (const h of app.metadataCache.getFileCache(f)?.headings ?? []) {
      const key = h.heading.trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, h.heading.trim());
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
