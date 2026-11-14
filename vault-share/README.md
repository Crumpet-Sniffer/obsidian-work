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
| Sources | Add Word and PowerPoint files to a vault. Each is converted to a note and filed by Claude (see "Sources" below). |
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

An admin sets this up under **Admin → Microsidian**: the Anthropic API key, the model, the effort, free-text filing guidance, the folder names and the smallest image to keep.

- The conversion and filing run in the browser, using the plugin's own code from `../microsidian` (bundled into `static/ingest.js`).
- The call to Claude is made by the server, so **the API key never reaches a browser**. The server sets the model and effort from the admin's settings whatever the browser sent. The key is stored in the database in the data folder and is never shown again after saving. If none is saved, the `ANTHROPIC_API_KEY` environment variable is used.
- What is sent to Anthropic for each source: the converted text of that file, the filing guidance, and a catalogue of the vault (folder names, note titles, topic names and definitions; at most 500 notes).
- Each account can file at most 500 sources an hour, and every call is written to the audit log with its token counts.
- **Admin → API spend** shows a line graph of estimated spend per day for the last 30 days, with totals, in pounds. Costs are worked out from each call's token counts and Anthropic's list prices in US dollars (see `src/spend.rs`; update the prices there if they change) and converted at the dollar-to-pound rate. By default the server looks that rate up about twice a day from `api.frankfurter.dev` (European Central Bank reference rates; free, no key, and nothing about the site is sent); an admin can tick "Set the rate myself" to stop the lookups and type a rate instead. If a lookup fails, the last rate fetched stays in use. It is an estimate; the Anthropic invoice is the true figure.
- The container needs outbound HTTPS to `api.anthropic.com` for this. The only other outbound request the site makes is the exchange-rate lookup below.
- Not carried over from the plugin: skipping template logos that repeat across many files (repeated logos are saved as images), and re-syncing a note when its original changes.

## Features beyond reading

Tabs, split view (Alt+click a link, or right-click a note), hover previews, bookmarks, search with operators (`file:`, `path:`, `tag:`, `content:`, `-word`, `"phrase"`), a tags list, outline and links panels, properties, callouts, math (KaTeX), Mermaid diagrams, graph view with groups, forces, display options and arrows, a quick switcher (Ctrl+O) and Word/PowerPoint viewers.

## Building the browser bundles

`static/office.js`, `editor.js`, `render.js`, `mermaid.js`, `graph.js` and `ingest.js` are built from `viewer/` and committed (`ingest.js` also bundles source from `../microsidian`):

```bash
cd viewer && npm install && npm run build
```

## Not supported (yet)

- Obsidian plugins (Dataview, Excalidraw rendering and so on) and Canvas view. These files are kept but shown as downloads or plain text.
- Note transclusion (`![[Other note]]` renders as a link instead of inlining the note).
- Real-time collaboration: two people editing the same note will get a conflict prompt rather than merged changes.
