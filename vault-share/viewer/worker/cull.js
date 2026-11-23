// Culling a zip of course files before anything is filed: only resource files are kept (Word, PowerPoint and PDF
// documents, and pictures big enough to be content rather than icons), from any subfolder. Everything else (videos,
// spreadsheets, shortcuts, system and temporary files, folders such as __MACOSX) is left out and counted.
// Used by the Sources page (before uploading, so less is sent) and by the ingest worker (for zips sent whole).

export const DOCUMENT = /\.(docx|pptx|pdf)$/i;
export const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const SYSTEM_FILES = new Set(["thumbs.db", "desktop.ini", ".ds_store", "icon\r"]);

const PLURAL = {
  "system or hidden file": "system or hidden files",
  "temporary file": "temporary files",
  "empty file": "empty files",
  "small picture": "small pictures",
  "file with no extension": "files with no extension",
};

const basename = (p) => p.split("/").pop();
const extOf = (p) => {
  const b = basename(p);
  return b.includes(".") ? b.slice(b.lastIndexOf(".") + 1).toLowerCase() : "";
};

/**
 * Why a file of a zip is left out, or "" to keep it. `path` uses forward slashes; `size` is its unpacked size
 * in bytes (or undefined when unknown).
 */
export function cullReason(path, size, { imageMinBytes = 0 } = {}) {
  const name = basename(path);
  const segs = path.split("/");
  if (segs.some((s) => s === "__MACOSX") || segs.some((s) => s.startsWith(".")) || SYSTEM_FILES.has(name.toLowerCase())) return "system or hidden file";
  if (name.startsWith("~$")) return "temporary file";
  if (DOCUMENT.test(name)) return size === 0 ? "empty file" : "";
  if (PICTURE.test(name)) return size !== undefined && size < imageMinBytes ? "small picture" : "";
  const ext = extOf(name);
  return ext ? `.${ext}` : "file with no extension";
}

/**
 * Cull a list of { path, size, ...anything } entries (folders already left out). Returns the kept ones (sorted by
 * path), how many were culled, and a short summary such as "12 .pdf, 3 .mp4, 2 system or hidden files".
 */
export function cullEntries(entries, opts) {
  const kept = [];
  const counts = new Map();
  for (const e of entries) {
    const why = cullReason(e.path, e.size, opts);
    if (!why) kept.push(e);
    else counts.set(why, (counts.get(why) || 0) + 1);
  }
  kept.sort((a, b) => a.path.localeCompare(b.path));
  const culled = [...counts.values()].reduce((a, b) => a + b, 0);
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([why, n]) => (why.startsWith(".") || n === 1 ? `${n} ${why}` : `${n} ${PLURAL[why] || why}`))
    .join(", ");
  return { kept, culled, summary };
}

/**
 * The files of a JSZip archive, culled. Some tools (Windows PowerShell's Compress-Archive, older Windows zippers)
 * write folder separators as backslashes, so names are normalised first. Kept entries are { e, path, size }.
 */
export function cullZip(zip, opts) {
  const entries = Object.values(zip.files)
    .map((e) => ({ e, path: e.name.replace(/\\/g, "/"), size: e._data && typeof e._data.uncompressedSize === "number" ? e._data.uncompressedSize : undefined }))
    .filter(({ e, path }) => !e.dir && !path.endsWith("/"));
  return cullEntries(entries, opts);
}
