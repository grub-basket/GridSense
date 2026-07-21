# GridSense

Excel-grade grid over your Obsidian notes' frontmatter — a standalone alternative to Bases for hands-on-the-keyboard data editing.

## What it does

- **Folder-scoped grid view** — open any folder as an editable table (folder context menu → *Open in GridSense*, or the command/ribbon). Rows are notes; columns are the union of frontmatter properties, ordered by usage.
- **Real multi-cell selection** — click-drag, Shift+click, Shift+arrows, click a header to select a column.
- **Excel keys** — arrows/Tab/Enter navigation, type-to-edit, F2/Enter to edit, Esc, ⌘D fill down, ⌘R fill right, ⌘C/⌘V TSV copy-paste (works with real spreadsheets), Delete clears, ⌘Z undo.
- **Find & replace in selection** (⌘F) — or the whole grid when nothing is selected.
- **Heading-content columns** — add a read-only column showing each note's body text under a chosen heading (for the stuff you keep outside frontmatter).
- **Compiled database** — the grid is rendered from a compiled snapshot of your frontmatter, persisted as JSON under `.obsidian/plugins/gridsense/db/`, auto-invalidated by metadata-cache events.
- **Keyboard-first property editor** — command *Edit properties of current note*: navigate, edit, rename, add, and delete properties without touching the mouse; every write is undoable.

All writes go through Obsidian's `processFrontMatter` — nothing touches your note bodies.

## Installation

**GridSense is in the [community plugin store](https://community.obsidian.md/plugins/gridsense)** — in Obsidian, go to Settings → Community plugins → Browse, search for "GridSense", install, and enable.

Other ways to install:

- **BRAT** (for pre-release builds): add `grub-basket/GridSense` in [BRAT](https://github.com/TfTHacker/obsidian42-brat).
- **Manual**: download `main.js`, `manifest.json`, and `styles.css` from the latest release and copy them into `<your vault>/.obsidian/plugins/gridsense/`, then enable **GridSense** in Settings → Community plugins.

## License

[MIT](LICENSE)
