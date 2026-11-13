/** Where Microsidian keeps things in a vault. Every name is a setting; these are the defaults. */
export interface Layout {
  /** Folder that holds the original .docx/.pptx files (mirrors the notes' folder structure). */
  originals: string;
  /** Folder that holds images extracted from documents. */
  attachments: string;
  /** Folder of topic pages (one note per concept, listing the notes that cover it). */
  topics: string;
  /** Optional note that lists all topics; updated when it exists. */
  topicsIndex: string;
  /** Folder you drop new documents into. */
  ingest: string;
}

export const DEFAULT_LAYOUT: Layout = {
  originals: "_Originals",
  attachments: "_Attachments/images",
  topics: "Topics",
  topicsIndex: "Topics - Index",
  ingest: "Ingest",
};

export function trimFolder(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Is `path` the folder itself or inside it? */
export function under(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder + "/");
}

/** Folders that hold Microsidian's own files, not notes to file or link. */
export function systemFolders(l: Layout): string[] {
  return [l.originals, l.attachments.split("/")[0], l.topics, l.ingest].filter(Boolean);
}

export function isSystemPath(path: string, l: Layout): boolean {
  return systemFolders(l).some((f) => under(path, f)) || path.split("/").some((s) => s.startsWith("."));
}

/** Top-level folder of a vault path, or "" for notes at the vault root. */
export function topFolder(folder: string): string {
  return folder.split("/")[0] ?? "";
}
