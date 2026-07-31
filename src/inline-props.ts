import { App, MarkdownView, Notice, TFile, debounce } from "obsidian";
import type GridSensePlugin from "./main";
import { EditEngine } from "./edits";
import { PropsEditor } from "./props-editor";
import { appendHistory } from "./history-log";

const BODY_CLASS = "gridsense-inline-props";
const STRIP_CLASS = "gridsense-inline-strip";

interface Mount {
  strip: HTMLElement;
  editor: PropsEditor;
  filePath: string;
}

/**
 * The inline frontmatter takeover: hides Obsidian's native properties panel
 * (CSS via a body class) and mounts our keyboard-friendly PropsEditor in its
 * place inside every markdown view — Live Preview and Reading mode alike.
 */
export class InlinePropsManager {
  private mounts = new Map<MarkdownView, Mount>();
  private detachFns: (() => void)[] = [];
  private refresh = debounce(() => this.mountAll(), 150, true);

  constructor(private app: App, private plugin: GridSensePlugin) {}

  /** Effective takeover state for one note: per-note override beats global. */
  activeFor(path: string): boolean {
    const o = this.plugin.settings.inlinePropsOverrides[path];
    return o === undefined ? this.plugin.settings.inlineProps : o;
  }

  async setOverride(path: string, on: boolean | null) {
    if (on === null) delete this.plugin.settings.inlinePropsOverrides[path];
    else this.plugin.settings.inlinePropsOverrides[path] = on;
    await this.plugin.saveSettings();
    this.apply();
  }

  /** Wire workspace events once; both modes (takeover on/off) need them. */
  start() {
    if (this.detachFns.length) return;
    const ws = this.app.workspace;
    const r1 = ws.on("layout-change", () => this.refresh());
    const r2 = ws.on("active-leaf-change", () => this.refresh());
    const r3 = ws.on("file-open", () => this.refresh());
    const r4 = this.app.metadataCache.on("changed", (f) => this.onMetaChanged(f));
    this.detachFns = [
      () => ws.offref(r1),
      () => ws.offref(r2),
      () => ws.offref(r3),
      () => this.app.metadataCache.offref(r4),
    ];
    this.apply();
  }

  /** Reflect the current setting: takeover strip, or just the toggle button. */
  apply() {
    // Per-note overrides mean the takeover can differ view-to-view, so the
    // native panel is hidden per container rather than via a body class.
    document.body.removeClass(BODY_CLASS);
    this.mountAll();
  }

  enable() {
    this.start();
    this.apply();
  }

  disable() {
    for (const [, m] of this.mounts) m.strip.remove();
    this.mounts.clear();
    this.mountAll(); // leaves the "GridSense properties" switch-back button
  }

  stop() {
    document.body.removeClass(BODY_CLASS);
    document.querySelectorAll(".metadata-container").forEach((el) => el.removeClass(BODY_CLASS));
    this.detachFns.forEach((fn) => fn());
    this.detachFns = [];
    for (const [, m] of this.mounts) m.strip.remove();
    this.mounts.clear();
    document
      .querySelectorAll(".gridsense-enable-toggle")
      .forEach((el) => el.remove());
  }

  private onMetaChanged(file: TFile) {
    for (const [, m] of this.mounts)
      if (m.filePath === file.path && !m.editor.editing) m.editor.load();
  }

  private mountAll() {
    const seen = new Set<MarkdownView>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      seen.add(view);
      const host = view.containerEl.querySelector(".metadata-container") as HTMLElement | null;
      const on = this.activeFor(view.file.path);
      host?.toggleClass(BODY_CLASS, on);
      if (on) {
        view.containerEl.querySelectorAll(".gridsense-enable-toggle").forEach((el) => el.remove());
        host?.removeClass("gridsense-has-toggle");
        this.ensureMount(view, view.file);
      } else {
        const m = this.mounts.get(view);
        if (m) {
          m.strip.remove();
          this.mounts.delete(view);
        }
        this.ensureOffToggle(view);
      }
    }
    // Drop mounts whose views are gone.
    for (const [view, m] of [...this.mounts]) {
      if (!seen.has(view)) {
        m.strip.remove();
        this.mounts.delete(view);
      }
    }
  }

  /** Takeover disabled: offer a one-click switch above Obsidian's panel. */
  private ensureOffToggle(view: MarkdownView) {
    const host = view.containerEl.querySelector(".metadata-container") as HTMLElement | null;
    if (!host) return;
    if (host.querySelector(".gridsense-enable-toggle")) return;
    const btn = host.createEl("button", {
      cls: "gridsense-strip-toggle gridsense-enable-toggle",
      text: "GridSense properties",
    });
    btn.setAttr("title", "Switch this note to GridSense's property editor (beta)");
    host.addClass("gridsense-has-toggle");
    // Sit in Obsidian's own heading row (whose title we hide) rather than
    // stacking a second line above it.
    const heading = host.querySelector(".metadata-properties-heading");
    if (heading) heading.prepend(btn);
    else host.prepend(btn);
    const path = view.file?.path;
    btn.addEventListener("click", async () => {
      if (path) await this.setOverride(path, true);
    });
  }

  private ensureMount(view: MarkdownView, file: TFile) {
    const host = view.containerEl.querySelector(".metadata-container") as HTMLElement | null;
    if (!host) {
      // Properties panel not rendered (e.g. source mode, or no frontmatter and
      // "show properties" off) — nothing to take over here.
      const existing = this.mounts.get(view);
      if (existing) {
        existing.strip.remove();
        this.mounts.delete(view);
      }
      return;
    }
    const existing = this.mounts.get(view);
    if (existing && existing.strip.isConnected && host.contains(existing.strip)) {
      if (existing.filePath !== file.path) {
        existing.filePath = file.path;
        existing.editor.setFile(file);
      }
      return;
    }
    existing?.strip.remove();
    const strip = host.createDiv({ cls: STRIP_CLASS });
    // Escape hatch: flip this note's panel back to Obsidian's own properties
    // UI without a trip to settings (and back again).
    const toggle = strip.createEl("button", {
      cls: "gridsense-strip-toggle",
      text: "Obsidian properties",
    });
    toggle.setAttr("title", "Switch back to Obsidian's properties panel (GridSense setting)");
    toggle.addEventListener("click", async () => {
      await this.setOverride(file.path, false);
      new Notice(`GridSense: "${file.basename}" now uses Obsidian's properties panel`);
    });
    const engine = new EditEngine(this.app, (entry) =>
      void appendHistory(
        this.app,
        file.parent?.path === "/" ? "" : file.parent?.path ?? "",
        entry
      )
    );
    const editor = new PropsEditor(this.app, file, strip, engine, { plugin: this.plugin });
    editor.mount();
    this.mounts.set(view, { strip, editor, filePath: file.path });
  }
}
