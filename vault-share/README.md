# Vault Share

A small, self-hosted Rust web app for sharing Obsidian vaults with classmates. You create
accounts, and everyone reads and edits the vaults in the browser behind a login: upload a vault
as a `.zip` or start an empty one, and add Word and PowerPoint files that are turned into linked
notes. Wikilinks, embeds, the folder tree, search and the graph all work. Nothing is public.

- **Rust**: axum + tokio, SQLite (bundled), Askama templates. No JavaScript framework.
- **Single container**: distroless, non-root, read-only filesystem, roughly 30 MB.
- **Data**: everything lives in one folder (`/data`): the SQLite database and the extracted vaults.

## Features

| | |
|---|---|
| Vaults | Any account can create a vault: empty, or from a .zip of an Obsidian vault. An admin can re-upload a zip to update it; links stay the same. |
| Practice | Quizzes and flashcards Claude writes from chosen topics, a question hub of past exam questions with their mark schemes, marking by Claude, history, and an exam coach (see "Practice" below). |
| Sources | Add Word and PowerPoint files and pictures to a vault, or a zip of them (culled to just those first). Each is converted to a note and filed by Claude (see "Sources" below). |
| Resources | A live tracker in the top right of every page shows the NAS's CPU, memory and data disk, and the site's own CPU and memory (server plus ingest worker); click it for details. |
| Reading | Obsidian-style `[[wikilinks]]`, `[[Note#Heading\|alias]]`, `![[image.png\|300]]` embeds, audio/video/PDF, `==highlights==`, callouts (`> [!NOTE]`), task lists, tables, footnotes, frontmatter hidden |
| Navigation | Collapsible file tree, full-text search, mobile layout, dark mode |
| Accounts | Admin creates accounts with a one-time password; classmates must set their own at first sign-in |
| Roles | **Users** can open and edit every vault, create vaults, and add and remove sources. **Admins** can also create accounts, delete or replace vaults, and change the Microsidian settings. |
| Admin | Reset passwords, disable or delete accounts, promote/demote, activity log |

## Security controls

**Authentication and sessions**
- Passwords hashed with **Argon2id** (random salt). Minimum 12 characters; rejects passwords containing the username, repetitive passwords and very common ones.
- **No self-registration.** Only an admin can create accounts. New and reset accounts get a random one-time password and **must change it** at first sign-in. The bootstrap admin must change theirs too.
- **Brute-force protection**: after 10 failures per IP or 8 per username within 15 minutes, sign-in is locked for 15 minutes. Failures and lockouts are written to the audit log.
- Unknown usernames still run a full Argon2 check and get the same error message, so usernames can't be discovered by timing or wording.
- Session tokens are 256-bit random values. **Only their SHA-256 hash is stored**, so a copied database can't be used to hijack sessions. Each login creates a fresh token (no session fixation).
- Cookies are `HttpOnly`, `Secure`, `SameSite=Lax` and use the `__Host-` prefix. Sessions expire after 24 h idle or 7 days total. There is a cap of 10 sessions per user.
- Changing your password signs out every other device. Disabling, resetting, deleting or changing the role of a user kills their sessions immediately.
- Admins can't disable, demote or delete the last remaining admin, or their own account.

**Request forgery and browser hardening**
- **CSRF tokens** (per session, compared in constant time) on every state-changing form, plus an **Origin / Sec-Fetch-Site check** that blocks cross-site POSTs.
- Strict **Content-Security-Policy**: no inline script, no third-party script, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`.
- Also sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, COOP/CORP `same-origin`, `Permissions-Policy`, HSTS (when HTTPS), `Cache-Control: no-store` on pages, and `X-Robots-Tag: noindex`.
- Login redirects (`?next=`) only accept local paths, so they can't be used as an open redirect.

**Uploaded content**
- Rendered Markdown passes through the **ammonia allow-list sanitizer**. A malicious note cannot inject `<script>`, event handlers, iframes, forms, SVG, or `javascript:` links.
- User files are served with a **sandboxed CSP** and `nosniff`, and every file is served with an explicit MIME type from a whitelist. A malicious SVG opened directly can't run script.
- Only whitelisted file types are kept: notes, images, audio, video, PDF, txt/csv, canvas and Office files. `.obsidian/` (plugins and settings), `.git`, `.trash`, other hidden files, `__MACOSX` and symlinks are dropped.

**ZIP extraction**
- Zip-slip (`../`) and absolute paths are rejected.
- **Zip-bomb limits** are enforced on the actual decompressed bytes, not on what the ZIP header claims: 2 GB total, 256 MB per file, 20,000 files by default.
- Extraction goes into a private staging folder first and is swapped in atomically. A failed upload never leaves a half-extracted vault behind.
- Upload size is capped at 512 MB by default, and uploads are streamed to disk, never held in memory. Only one extraction runs at a time.

**Authorization**
- Every vault page and file needs a signed-in account. Every account can open every vault; deleting or replacing a vault, creating accounts and changing settings need the admin role.
- File access is only possible for paths in the vault's index, which excludes traversal, hidden files and symlinks.

**Operations**
- The **audit log** (in Admin) records sign-ins, failures, lockouts, uploads, sharing changes and account changes, kept for 180 days.
- The container runs as non-root UID 568 with a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, and PID, memory and CPU limits. Internal errors are logged but never shown to the browser.

## Deploying on TrueNAS SCALE (24.10 "Electric Eel" or newer)

### 1. Create a data folder

In **Datasets**, create e.g. `tank/apps/vault-share`. Give it to the apps user: open a shell (**System → Shell**) and run:

```bash
sudo chown -R 568:568 /mnt/tank/apps/vault-share
```

### 2. Get the source onto the NAS and build the image

Copy this `vault-share` folder to the NAS, for example into an SMB share at `/mnt/tank/apps/vault-share-src`. Or push it to a Git repo and `git clone` it there. Then in the TrueNAS shell:

```bash
sudo docker build -t vault-share:latest /mnt/tank/apps/vault-share-src
```

The first build takes a few minutes (it compiles Rust). Re-run this command after updating the source, then restart the app.

### 3. Install the app

**Apps → Discover Apps → ⋮ → Install via YAML**. Name it `vault-share` and paste [docker-compose.yml](docker-compose.yml). Before saving, change:
- the volume path, to your dataset from step 1
- `PUBLIC_ORIGIN`, to the URL your classmates will use
- optionally `ADMIN_PASSWORD`. If you leave it unset, a random admin password is printed in the app's logs on first start (**Apps → vault-share → Logs**).

### 4. Make it reachable over HTTPS

Your classmates are outside your home network, so they need HTTPS. **Don't port-forward port 8080 on your router.** Pick one of these:

- **Cloudflare Tunnel (recommended).** No open ports and free HTTPS. You need a domain on Cloudflare. Uncomment the `cloudflared` block in the compose file, paste the tunnel token, and point the tunnel's public hostname at `http://vault-share:8080`. Then remove the `ports:` section so the app can only be reached through the tunnel. Optionally add Cloudflare Access in front for an extra email-code check.
- **Tailscale.** Install the Tailscale app on TrueNAS and share the machine with classmates' Tailscale accounts. Set `COOKIE_SECURE=false` and `TRUST_PROXY=false` if you use plain `http://` over the tailnet, or use `tailscale serve` for HTTPS.
- **Your own reverse proxy** (Nginx Proxy Manager, Caddy, Traefik) with a Let's Encrypt certificate, forwarding to port 8080.

> `TRUST_PROXY=true` makes the app take the client IP from `X-Forwarded-For`. Only enable it when every request passes through your proxy or tunnel. Otherwise someone could fake their IP to dodge the per-IP lockout. The per-username lockout still applies either way.

### 5. First sign-in

1. Open your URL, sign in as `admin`, and set a new password.
2. **Admin → Upload a vault**: right-click your vault folder → *Compress to ZIP file*, then upload it.
3. **Admin → Accounts**: create an account per classmate and send each one their one-time password privately.
4. On the vault's page, choose *Share with every member account* or grant access person by person.
5. Remove `ADMIN_PASSWORD` from the app's YAML if you set it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/data` | Database and vault storage |
| `BIND_ADDR` | `0.0.0.0:8080` | Listen address |
| `SITE_NAME` | `Vault Share` | Shown in the header and page titles |
| `COOKIE_SECURE` | `true` | Secure cookies + HSTS. Set `false` only for plain-HTTP testing |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` / `X-Forwarded-Host` |
| `PUBLIC_ORIGIN` | unset | e.g. `https://notes.example.com`. When set, form posts must come from exactly this origin, so opening the app by LAN IP won't let you submit forms |
| `ADMIN_USERNAME` | `admin` | Bootstrap admin (only when the database is empty) |
| `ADMIN_PASSWORD` | random | Bootstrap admin password; must be changed at first sign-in |
| `MAX_UPLOAD_MB` | `512` | Max .zip size |
| `MAX_EXTRACTED_MB` | `2048` | Max total size after extraction |
| `MAX_FILE_MB` | `256` | Max size of one file inside the zip |
| `MAX_FILES` | `20000` | Max number of files in a vault |
| `SESSION_IDLE_HOURS` | `24` | Sign out after this long without activity |
| `SESSION_MAX_DAYS` | `7` | Sign out after this long regardless |
| `RUST_LOG` | `info` | Log level |
| `ANTHROPIC_API_KEY` | unset | API key for filing sources, used when no key is saved on the Admin page |
| `OCR_DIR` | `/usr/local/share/vault-share/ocr` | Folder with the OCR models (already in the Docker image) |
| `NODE_BIN` | `node` | Node.js, to run the ingest worker (set in the Docker image) |
| `INGEST_WORKER` | `/usr/local/share/vault-share/worker/worker.mjs` | The ingest worker's script (set in the Docker image). Without it, sources can be uploaded but wait in the queue |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Where the Anthropic API is (an HTTPS gateway, or a local mock for testing) |

## Backups

Snapshot the dataset (TrueNAS **Data Protection → Periodic Snapshot Tasks**). Everything is in that one folder.

## Running locally (for development)

```bash
DATA_DIR=./data COOKIE_SECURE=false BIND_ADDR=127.0.0.1:8080 cargo run
```

Then open http://127.0.0.1:8080. The initial admin password is printed in the log. Run the unit tests with `cargo test`.

## Editing

Every account can edit every vault (create, edit, rename, move, delete notes and folders, paste images). Only give accounts to people you trust with that.

- **Editor:** open a note and press **Ctrl+E** (or the pencil). It autosaves, completes `[[links]]`, and pastes or drops images as attachments. A save is refused (and you are asked what to do) if the note changed on the server since you opened it.
- **Files:** use the buttons above the file list, or right-click an item. Renaming a note can update links in other notes. Items can be dragged onto folders.
- **Deleting is safe:** things move to a hidden `.trash` folder inside the vault (not shown on the site, but present on disk and in backups).
- **Re-uploading replaces everything**, including edits made on the site. The previous version is saved first as a zip (the last three are kept, under **Admin → the vault → Backups**).
- Every create, rename, delete and upload is recorded in the audit log.

## Sources (Microsidian on the site)

Open a vault and press **+** in the sidebar (or go to **Admin → Vaults → Sources**) to add `.docx` and `.pptx` files, or a `.zip` of them (every Word and PowerPoint file in the zip is added, whatever subfolder it is in; the zip is unpacked in the browser). For each file the site does what the Microsidian Obsidian plugin does: converts it to a note, asks Claude where it belongs, checks the answer against what really exists in the vault, then files the original under the originals folder, writes the note, links it to topics and related notes, and updates topic and index pages. Filing is automatic; there is no review step. **Remove** moves the original and its note to the vault's trash and takes the note out of topic and index pages.

An admin sets this up under **Admin → Microsidian**: the Anthropic API key, the model, the effort, free-text filing guidance, how pictures are read, the system prompts, the folder names and the smallest image to keep.

- **System prompts:** the instructions for each kind of call (filing one document, planning a batch, reading a picture) can be edited there. An empty box, or "Use the default", means the built-in prompt (`src/prompts.rs`, a copy of the plugin's; `cargo test` checks they match). The filing guidance is added after the prompt either way.
- **Zips are culled first:** only Word, PowerPoint, PDF and picture files (not icons under the smallest-image size) are kept, from any subfolder; videos, spreadsheets, system and temporary files and so on are left out and listed. The Sources page does this in the browser before uploading (for zips up to 400 MB; larger ones are sent whole and culled by the worker), so less is sent (`viewer/worker/cull.js`, shared by both).
- **PDFs:** read by pdf.js in the worker (`viewer/worker/pdf.js`): each page's text under a "Page N" heading, and the pictures drawn on it, saved as PNG and read like any source's pictures (OCR or Claude). A scanned PDF's pages are pictures, so that is also how its text is read. The original is filed and opens in the browser's PDF viewer.
- **Pictures as sources:** a .png, .jpg, .gif or .webp added on its own becomes a note with the picture, its text and (with Claude) a description, filed and linked like any other source.

- **Sources are added on the server, in the background.** The Sources page only uploads the files (as one batch, with a progress bar); once the upload has finished the page can be closed, and opened again later from any browser to see how it went. The work is done by the ingest worker, a Node.js process the server starts and restarts if it stops (`src/worker.rs`), running the plugin's own code from `../microsidian` (bundled into `worker/worker.mjs`). It picks up one batch at a time and is given a session of the account that uploaded it, so it reads and writes the vault through the normal API with exactly that account's rights, and every change is audited as usual. It reaches the server over loopback only, with a token that changes on every start, and is started with an empty environment (it never sees the API key or the admin password). A batch that was running when the server stopped is resumed when it starts again, skipping files already filed. The owner of a batch, or an admin, can stop it; files already filed stay. Uploaded files are deleted when the batch ends; batch records are kept for 30 days.
- The call to Claude is made by the server, so **the API key never reaches a browser**. The server sets the model and effort from the admin's settings whatever the browser sent. The key is stored in the database in the data folder and is never shown again after saving. If none is saved, the `ANTHROPIC_API_KEY` environment variable is used.
- **Files added together are planned together.** Files picked or dropped at once, or from one zip, form a batch. First every file is read (and the text in its pictures, below). Then Claude reads the whole batch at once, with the vault's catalogue, and plans it: the topics the batch needs, and a folder and a one-line summary for each file. Then each file gets its own call as before, but against the vault plus the plan, so it can be linked to any other file of the batch, including ones filed after it, and it uses the planned folder. This costs one extra call per batch, the size of all its files together; a batch too large for one request (about 2 million characters) has its longest files shortened for the plan only, and the page says so. If planning fails, each file is filed on its own. A single file skips planning. The Sources page shows a progress bar for the batch and for each step (upload, reading, planning, filing), and one per file.
- **Pictures: OCR or Claude.** Under Admin → Microsidian → Pictures in sources, an admin chooses how the pictures in a source are read. Pictures are read several at a time ("Pictures read at once").
  - **OCR** (the default; below): only their words, on this server. The pictures never leave it.
  - **Claude, with a picture model** (Claude Haiku 5.5 by default, at low effort): each picture, scaled down to 1568 px, gets its own small call; the words it finds and a short description go into what the filing model reads, inside `<image_text>` and `<image_description>` tags. These calls have their own cap (6,000 an hour per account) and appear in the spend chart under the picture model.
  - **Claude, without a picture model:** the filing model is shown up to 100 pictures of each file itself, each right after its embed (more expensive; the batch plan then sees only the files' text).
- **Text in pictures (OCR):** before asking Claude, the worker reads the text in each of the file's pictures (those above the smallest-image size) with OCR, using PaddleOCR's PP-OCRv6 small models run by ONNX Runtime's native Node.js build on every CPU core (`viewer/worker/ocr.js`; about a second a picture). That text is placed after each picture in what Claude reads, inside `<image_text>` tags. The pictures themselves are never sent. If OCR cannot run, the source is still filed from its own text and the result says so. The Docker image includes the models and the worker; outside Docker run `node viewer/fetch-ocr.mjs`, `npm ci` in `worker/`, and set `OCR_DIR`, `NODE_BIN` and `INGEST_WORKER` (below).
- What is sent to Anthropic for each source: the converted text of that file, the text read from its pictures, the filing guidance, and a catalogue of the vault (folder names, note titles, topic names and definitions; at most 500 notes).
- Each account can file at most 500 sources an hour, and every call is written to the audit log with its token counts.
- **Admin → API spend** shows a line graph of estimated spend per day for the last 30 days, with totals, in pounds. Costs are worked out from each call's token counts and Anthropic's list prices in US dollars (see `src/spend.rs`; update the prices there if they change) and converted at the dollar-to-pound rate. By default the server looks that rate up about twice a day from `api.frankfurter.dev` (European Central Bank reference rates; free, no key, and nothing about the site is sent); an admin can tick "Set the rate myself" to stop the lookups and type a rate instead. If a lookup fails, the last rate fetched stays in use. It is an estimate; the Anthropic invoice is the true figure.
- The container needs outbound HTTPS to `api.anthropic.com` for this. The only other outbound request the site makes is the exchange-rate lookup below.
- Not carried over from the plugin: skipping template logos that repeat across many files (repeated logos are saved as images), and re-syncing a note when its original changes.

## Practice (questions, flashcards, past papers, exam coach)

Open a vault and press the cap icon in the sidebar (`/v/{id}/practice`). Everything here uses Claude with the key, model and effort set under Admin → Microsidian, and each account's answers and results are private to it.

- **Questions:** choose topics (the vault's topic pages), question types (select one option, select multiple options, fill in the blanks, written answer), mark levels and difficulty, each group with "Select all", and how many questions (up to 30, or "Just one"). Claude writes them from the notes on those topics (the topic page and every note linking to it), and, when the question hub has past papers, models their wording, command words and mark schemes on the most similar past questions. Choice and fill-in answers are marked at once; written answers are marked by Claude against the mark scheme (several at a time), with marks, feedback, the points met and missed, a model answer and the mark scheme. Questions Claude writes are kept in the question hub too.
- **Question hub:** upload a .zip of past papers and mark schemes (in any folders). The worker looks at the start of every PDF, Word and PowerPoint file in it, and Claude works out which are question papers, which mark scheme and inserts (case studies, source booklets, data sheets) go with each, and each paper's qualification, paper number, month and year (papers already in the hub are skipped). Other versions of a paper (modified, enlarged print) count as one paper: the standard version is read, with the mark scheme and inserts found for any version, and the other versions only if it cannot be. If the Anthropic account runs out of credit, the upload stops and says so; upload the same zip again later and only what is missing is added. Each paper is then added as below, two at a time, named like "June 2024 Paper 1". One paper can also be added by hand: upload an exam paper, its mark scheme and its insert (PDF, Word or PowerPoint). The ingest worker reads them (with the text in their pictures), keeps them in the vault under `<originals>/Question Hub/<name>/`, and Claude splits the paper into its questions, each with its number, marks, type, topics and its part of the mark scheme, quoting what it needs from the insert (`viewer/worker/paper.js`). Questions from a paper with an insert link to it. Papers are shown by exam year: each year lists every paper sat that year, the documents about that year, and the examiners' notes on the year as a whole (how candidates did, common mistakes, advice), which Claude writes from that year's examiner reports, commentaries and guidance whenever the guides are built; "Show this year's questions" filters the hub to it. Filter the hub by topic, type, mark level, exam year, source and paper, and practise any selection; answers are marked with the official mark scheme.
- **Specifications and other exam documents:** add a qualification's specification on its own, or put it in the zip with the papers along with examiner reports, answers and commentaries, and notes and guidance from the exam board's assessment resources (Claude works out what each file is; administrative documents are left out). Each is read by Claude into notes (content areas and which papers examine them, assessment details, command words, marking guidance, examiners' findings, sample answers) and kept in the vault under `<originals>/Question Hub/Resources/`.
- **Paper guides:** whenever a specification, paper or document is added, Claude builds a guide to each examined paper of the qualification from all of them: its fields (the specification areas it can examine, with the mark levels and question types they have carried), format, command words, how marks are earned, and common mistakes, and tags every past question with its fields. The hub shows each guide with the number of questions per field (click one to see them), and can filter by specification area. When writing questions, choose a paper to write for and which of its areas to cover: Claude follows that paper's guide and models the questions on that paper's past questions. Written answers to a paper's questions are marked with its marking tips and common mistakes in mind, and the exam coach sees the guides and the marks by specification area.
- **Flashcards:** decks written from the chosen topics' notes at a chosen difficulty; turn cards over, mark them Got it or Again (saved), shuffle, or go through only the Again cards. Keys: Space turns over, arrows move, 1 = Again, 2 = Got it.
- **History:** every set answered, with its score; reopen one to see the answers and feedback, or try the same questions again.
- **Exam coach:** a conversation with Claude, which is given a summary of the account's results (marks by topic, question type and mark level, flashcard results, and recent answers that lost marks) and says where marks are being lost and what to do next. The page shows the same summary as bars.
- All twelve system prompts (filing, planning, pictures, sorting a zip of exam documents, reading a paper, reading a specification or report, building paper guides, writing examiners' notes for each year, writing questions, marking, flashcards, coach) can be edited under Admin → Microsidian → System prompts. Calls count towards each account's hourly limit and appear in the spend chart and audit log.

## Features beyond reading

Tabs, split view (Alt+click a link, or right-click a note), hover previews, bookmarks, search with operators (`file:`, `path:`, `tag:`, `content:`, `-word`, `"phrase"`), a tags list, outline and links panels, properties, callouts, math (KaTeX), Mermaid diagrams, graph view with groups (colour or hide files by folder, file type, name, topic or search), forces, display options and arrows (all saved per account per vault; save them as named presets, load anyone's presets for that vault under "Other presets", and copy, paste or type the forces as a four-number force ID such as `0.30,10.0,1.00,60`: centre, repel, link, distance), a quick switcher (Ctrl+O) and Word/PowerPoint viewers.

## Building the browser bundles

`static/office.js`, `editor.js`, `render.js`, `mermaid.js`, `graph.js` and `ingest.js`, and the ingest worker `worker/worker.mjs`, are built from `viewer/` and committed (the worker also bundles source from `../microsidian`; its one native dependency, `onnxruntime-node`, is installed by the Dockerfile from `worker/package.json`). In `office.js`, Word files are drawn by docx-preview and PowerPoint files by the slide reader from [PPTX Viewer](https://github.com/MichalAFerber/pptx-viewer.us) (MIT, vendored as `viewer/pptx-viewer.js`), which shows each slide's text and pictures where the deck placed them:

```bash
cd viewer && npm install && npm run build
```

## Not supported (yet)

- Obsidian plugins (Dataview, Excalidraw rendering and so on) and Canvas view. These files are kept but shown as downloads or plain text.
- Note transclusion (`![[Other note]]` renders as a link instead of inlining the note).
- Real-time collaboration: two people editing the same note will get a conflict prompt rather than merged changes.
