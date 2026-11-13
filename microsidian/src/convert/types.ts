export interface ConvertOptions {
  /** Embed only images at least this big (smaller ones are bullets, icons, logos). */
  imageMinBytes: number;
  /** True for images that appear in many files (template logos): not embedded. */
  isLogo: (hash: string) => boolean;
  /** Vault-relative folder for extracted images, e.g. "_Attachments/images". */
  attachmentsDir: string;
  /** Vault path of the original, used for "open slide" links. Optional. */
  originalPath?: string;
}

export interface ImageOut {
  /** Vault-relative path the note embeds. */
  path: string;
  hash: string;
  data: Uint8Array;
}

export interface ConvertResult {
  /** Markdown body (no frontmatter, no title, no Original line, no Connections). */
  body: string;
  images: ImageOut[];
  /** Hashes of every raster image in the file (kept or not), for the logo index. */
  imageHashes: string[];
  slideCount: number;
  words: number;
}

export const DEFAULT_CONVERT: Omit<ConvertOptions, "isLogo"> = {
  imageMinBytes: 30_000,
  attachmentsDir: "_Attachments/images",
};
