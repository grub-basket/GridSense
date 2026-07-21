import { App, MarkdownView, TFile, debounce } from "obsidian";
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

  enable() {
    document.body.addClass(BODY_CLASS);
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
    this.mountAll();
  }

  disable() {
    document.body.removeClass(BODY_CLASS);
    this.detachFns.forEach((fn) => fn());
    this.detachFns = [];
    for (const [, m] of this.mounts) m.strip.remove();
    this.mounts.clear();
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
      this.ensureMount(view, view.file);
    }
    // Drop mounts whose views are gone.
    for (const [view, m] of [...this.mounts]) {
      if (!seen.has(view)) {
        m.strip.remove();
        this.mounts.delete(view);
      }
    }
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
    const engine = new EditEngine(this.app, (entry) =>
      void appendHistory(
        this.app,
        file.parent?.path === "/" ? "" : file.parent?.path ?? "",
        entry
      )
    );
    const editor = new PropsEditor(this.app, file, strip, engine);
    editor.mount();
    this.mounts.set(view, { strip, editor, filePath: file.path });
  }
}
