// Talking to the vault-share server from the ingest worker.
//  - internal(): the worker's own routes (claim a batch, report progress), with the token the server gave it.
//  - Session: the account that uploaded a batch. Every read and write of the vault, and the call to Claude, goes
//    through the normal API with that account's session, so the worker can do exactly what that account can.
import { Agent, fetch } from "undici";
import { under } from "../../../microsidian/src/config";

const SERVER = process.env.VS_SERVER;
const TOKEN = process.env.VS_WORKER_TOKEN;

// A call to Claude about a whole batch can take many minutes before its first byte: no header or body timeout.
const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 30_000 } });
const go = (url, init = {}) => fetch(url, { ...init, dispatcher: agent });

export async function internal(path, json) {
  const res = await go(`${SERVER}/internal/ingest/${path}`, {
    method: "POST",
    headers: { "X-Worker-Token": TOKEN, ...(json ? { "Content-Type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  if (res.status === 204) return null;
  // The server no longer knows this worker's token: it was restarted and has started a new worker.
  if (res.status === 404 && path === "claim") {
    console.log("this worker's server has gone; stopping");
    process.exit(0);
  }
  if (!res.ok) throw new Error(`The server answered ${res.status} to ${path}.`);
  return res.json();
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
const basename = (p) => p.split("/").pop();

export class Session {
  constructor(vault, session) {
    this.base = `${SERVER}/v/${vault}`;
    this.headers = { Cookie: `${session.cookie}=${session.token}`, "X-CSRF-Token": session.csrf };
  }

  async api(method, path, { json, body, query } = {}) {
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    const headers = { ...this.headers };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const res = await go(`${this.base}/api/${path}${qs}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `The server answered ${res.status}.`);
    return data;
  }

  async readFile(path) {
    const res = await go(`${this.base}/f/${encodePath(path)}`, { headers: this.headers });
    if (!res.ok) throw new Error(`Could not read ${path}.`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // The Anthropic SDK's request, sent to the server, which adds the API key, model and effort.
  claudeFetch = (_url, init = {}) => this.toClaude(init, {});

  // The same, for reading one picture: the server uses the model and effort chosen for pictures.
  claudeImageFetch = (_url, init = {}) => this.toClaude(init, { "X-Ingest-Purpose": "image" });

  toClaude(init, extra) {
    const beta = new Headers(init.headers || {}).get("anthropic-beta");
    const headers = { ...this.headers, ...extra, "Content-Type": "application/json" };
    if (beta) headers["anthropic-beta"] = beta;
    return go(`${this.base}/api/ingest/claude`, { method: "POST", headers, body: init.body, signal: init.signal });
  }
}

// Vault access for Microsidian's code (its VaultIO). Holds the text of every note, fetched in one request, so
// reads are local; writes go to the server. The same as SiteIO on the Sources page used to be.
export class ServerIO {
  constructor(session, layout) {
    this.s = session;
    this.layout = layout;
    this.files = new Set();
    this.notes = new Map();
    this.pending = null; // { path, bytes }: the file being added, which is not in the vault yet
  }

  async load() {
    const c = await this.s.api("GET", "ingest/corpus");
    this.files = new Set(c.files);
    this.notes = new Map(Object.entries(c.notes));
  }

  async exists(path) {
    return this.files.has(path) || (!!this.pending && this.pending.path === path);
  }

  async read(path) {
    if (this.notes.has(path)) return this.notes.get(path);
    const n = await this.s.api("GET", "note", { query: { path } });
    this.notes.set(path, n.content);
    return n.content;
  }

  async save(path, text, etag) {
    await this.s.api("PUT", "note", { json: etag ? { path, content: text, etag } : { path, content: text } });
    this.notes.set(path, text);
    this.files.add(path);
  }

  async write(path, text) {
    let etag;
    if (this.files.has(path)) etag = (await this.s.api("GET", "note", { query: { path } })).etag;
    await this.save(path, text, etag);
  }

  // Read, change and save. If someone saved the note in between, start again from their version.
  async edit(path, fn) {
    for (let attempt = 0; ; attempt++) {
      const cur = await this.s.api("GET", "note", { query: { path } });
      const next = fn(cur.content);
      if (next === cur.content) { this.notes.set(path, cur.content); return; }
      try {
        await this.save(path, next, cur.etag);
        return;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409 || attempt >= 2) throw e;
      }
    }
  }

  async rename(from, to) {
    if (this.pending && this.pending.path === from) {
      // Filing the new source: this is the moment it is written to the vault, straight to where it belongs.
      await this.writeBinary(to, this.pending.bytes);
      this.pending = { path: to, bytes: this.pending.bytes };
      return;
    }
    await this.s.api("POST", "rename", { json: { from, to, update_links: false } });
    this.files.delete(from);
    this.files.add(to);
    if (this.notes.has(from)) { this.notes.set(to, this.notes.get(from)); this.notes.delete(from); }
  }

  async readBinary(path) {
    if (this.pending && this.pending.path === path) return this.pending.bytes;
    return this.s.readFile(path);
  }

  async writeBinary(path, data) {
    await this.s.api("PUT", "ingest/file", { query: { path }, body: data });
    this.files.add(path);
  }

  markdownPaths() {
    const { originals, attachments, ingest } = this.layout;
    const skip = [originals, attachments.split("/")[0], ingest];
    return [...this.notes.keys()].filter((p) => !skip.some((s) => under(p, s)) && !p.split("/").some((seg) => seg.startsWith(".")));
  }

  // A bare link name such as "Topics - Index" to a note path, the way Obsidian resolves it.
  resolve(name) {
    if (this.notes.has(`${name}.md`)) return `${name}.md`;
    const want = `${basename(name)}.md`.toLowerCase();
    const hits = [...this.notes.keys()].filter((p) => basename(p).toLowerCase() === want);
    hits.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    return hits[0] ?? null;
  }
}
