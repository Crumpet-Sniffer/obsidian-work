# Microsidian

An Obsidian plugin (desktop only) that brings Word and PowerPoint files into your vault.

- **Open them in Obsidian.** `.docx` and `.pptx` files open in a tab with their real layout (Word: `docx-preview`,
  PowerPoint: `pptx-preview`). A link like `[[deck.pptx#slide-3]]` jumps to that slide.
- **Keep a searchable note for each file.** Every original has a paired Markdown note (text, tables, speaker notes, images,
  text-box text) so Obsidian's search, links, backlinks and graph work on it. Save the original and its note is rebuilt;
  its Connections block and topic links are kept.
- **See the connections.** A side panel shows the open note's topics, related notes and backlinks, and switches between a
  note and its original.
- **File new documents with Claude.** Drop a `.docx` or `.pptx` into the `Ingest` folder. Microsidian converts it, sends the text and
  a catalogue of your vault to Claude, checks the answer against what really exists, shows a review window, then files the
  original, writes the note, links it to topics and related notes, and updates the pages that list it.

## How a vault is laid out

| What | Default | Notes |
|---|---|---|
| Originals | `_Originals/` | Mirrors the folders your notes are in. A note's `source:` property points at its original. |
| Images | `_Attachments/images/` | Images taken from documents (small icons and repeated template logos are skipped). |
| Topics | `Topics/` | One note per concept, with a definition and the phrases that link to it, listing every note that covers it. |
| Topics index | `Topics - Index` | Optional. Updated when it exists. |
| Folder index notes | `<top folder> - Index` | Optional. When one exists for the folder a note is filed under, the note is added to it. |
| Ingest | `Ingest/` | Drop new documents here. `Ingest/_log.md` lists what was filed where. |

All of these names are settings. Notes can live in any folders you like; Microsidian does not assume a structure.

Each converted note ends with a Connections block between `%% connections:start %%` and `%% connections:end %%` (topics, related notes).
Sync, linking and the side panel all read it, so leave the markers in place.

## Filing guidance

The settings page has a free-text **filing guidance** box added to Claude's instructions, so you can describe your own rules without any code, for example:

> This vault holds my chemistry course. Do not file worksheets or answer sheets.
> Put every client document under Clients/<client name>.

If guidance says a document should not be filed, Claude marks it unsuitable and it stays in the Ingest folder.

## What is sent to Anthropic

Only when you drop a file in `Ingest`: the converted text of that one file, your guidance, and a catalogue of your vault (folder names,
note titles, topic names and definitions; at most 500 notes). A confirmation window shows the size and a cost estimate first
(turn it off with "File without asking"). The API key is kept in Obsidian's secret storage, never in the vault or the settings file.
The model is `claude-sonnet-5-5`.

## Install and develop

```bash
npm install
npm run build        # writes main.js; also installs into a vault if OBSIDIAN_VAULT (or install-target.txt) names one
```

In Obsidian: Settings -> Community plugins -> turn off Restricted mode -> enable **Microsidian**. Then add an Anthropic API key in the plugin's settings.
Requires Obsidian 1.11.4 or newer.

Commands: Open connections panel · Switch between note and original file · Re-sync the note for the open original ·
Re-sync all notes · Process the Ingest folder now · Rebuild the image index.

## Tests

No Obsidian, no API key and no network are needed, and the tests never write to a real vault. They run on a small generated sample vault
(`npm run fixture`) unless `MICROSIDIAN_VAULT` points at your own.

```bash
npm test                                   # typecheck, parity, sync-sim, ingest-sim, claude-mock
MICROSIDIAN_VAULT=/path/to/vault npm run parity    # the same checks on your own vault
```

| Script | What it checks |
|---|---|
| `scripts/parity.ts` | converts every original; every original paragraph (3+ words) must appear in the output |
| `scripts/sync-sim.ts` | simulated "re-sync all" on a copy: Connections kept, links resolve, nothing lost |
| `scripts/ingest-sim.ts` | filing on copies with a mock reply: existing and new folders, new topics, indexes, back-links, an empty vault, invented replies, and a round trip on the vault under test |
| `scripts/claude-mock.ts` | the Claude request (model, fallbacks, output format, guidance) and its error handling, against a mock server |
| render harness (`scripts/serve.mjs`) | renders every original with the viewer libraries in a browser |

## Known limits

- Word floating text boxes (for example cover pages) render approximately in the viewer; the note text is complete.
- PowerPoint rendering is approximate (some shapes, SmartArt and animations).
- The Obsidian-side code (viewer tab, side panel, dialogs, settings page, `requestUrl`) can only be exercised inside Obsidian;
  everything underneath it is covered by the tests above.
- Changing a folder name in the settings does not move existing files.
- If originals do not open, remove the originals folder from Settings -> Files and links -> Excluded files.
- Notes you wrote by hand are never edited, except that a Connections block already present in a note can receive a back-link.
