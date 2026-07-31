import { App, Menu, Notice } from "obsidian";

const BT_ID = "bases-toolbox";

/**
 * Bases Toolbox handshake.
 *
 * Its property-doctor tools (format doctor, property index, duplicate finder,
 * alias audit, allowed-value audit, inline-field migration, rollups, …) are
 * already built and maintained over there, so GridSense launches them rather
 * than growing a second copy. Integration by handshake, not by merger: if the
 * plugin isn't installed we simply don't advertise the menu.
 */
export interface ToolboxTool {
  command: string;
  title: string;
  icon: string;
  /** Shown when the tool works on one property (column menus). */
  perColumn?: boolean;
}

export const TOOLBOX_TOOLS: ToolboxTool[] = [
  { command: "format-doctor", title: "Format doctor (type mismatches)", icon: "stethoscope", perColumn: true },
  { command: "open-property-index", title: "Property index", icon: "list-tree", perColumn: true },
  { command: "audit-allowed-values", title: "Audit allowed values", icon: "check-check", perColumn: true },
  { command: "audit-aliased-links", title: "Audit aliased links", icon: "link", perColumn: true },
  { command: "fork-property", title: "Fork / convert property", icon: "git-branch", perColumn: true },
  { command: "find-duplicates-tab", title: "Find duplicate notes", icon: "copy" },
  { command: "migrate-inline-fields", title: "Migrate inline fields to frontmatter", icon: "move-right" },
  { command: "compute-rollup", title: "Compute rollup into frontmatter", icon: "sigma" },
  { command: "metadata-stamp", title: "Metadata stamp", icon: "clock" },
];

export function toolboxInstalled(app: App): boolean {
  return !!(app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.[
    BT_ID
  ];
}

function run(app: App, command: string): boolean {
  const id = `${BT_ID}:${command}`;
  const ok = (
    app as unknown as { commands: { executeCommandById: (id: string) => boolean } }
  ).commands.executeCommandById(id);
  if (!ok)
    new Notice(
      `GridSense: Bases Toolbox didn't accept "${command}" — it may have moved or renamed that tool.`
    );
  return ok;
}

/**
 * Add a "Property tools (Bases Toolbox)" submenu. Returns false when the
 * plugin isn't installed, so callers can offer an install hint instead.
 */
export function addToolboxMenu(app: App, menu: Menu, opts: { perColumn?: boolean } = {}): boolean {
  if (!toolboxInstalled(app)) return false;
  menu.addSeparator();
  menu.addItem((item) => {
    item.setTitle("Property tools (Bases Toolbox)").setIcon("wrench");
    const sub = (item as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
    const target = sub ?? menu;
    for (const tool of TOOLBOX_TOOLS) {
      if (opts.perColumn && !tool.perColumn) continue;
      target.addItem((sm) =>
        sm.setTitle(tool.title).setIcon(tool.icon).onClick(() => run(app, tool.command))
      );
    }
  });
  return true;
}
