import { createHash } from "crypto";
import type JSZip from "jszip";
import type { ConvertOptions, ImageOut } from "./types";

const RASTER = /\.(png|jpe?g|gif|bmp|svg|webp)$/i;

/** Collects the images of one Office file that are worth embedding in its note. */
export class Images {
  private media = new Map<string, Uint8Array>();
  out = new Map<string, ImageOut>();
  /** Every raster image hash in the file (used to build the "logo" index). */
  hashes = new Set<string>();

  private constructor(private opts: ConvertOptions) {}

  static async load(zip: JSZip, opts: ConvertOptions): Promise<Images> {
    const imgs = new Images(opts);
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir || !/\/media\//.test(name) || !RASTER.test(name)) continue;
      const data = await zip.file(name)!.async("uint8array");
      imgs.media.set(name, data);
      imgs.hashes.add(hash(data));
    }
    return imgs;
  }

  /** `![[path]]` for a media part if it passes the size/logo filters, else null. */
  embed(part: string | null | undefined): string | null {
    if (!part) return null;
    const data = this.media.get(part);
    if (!data) return null;
    if (data.length < this.opts.imageMinBytes) return null;
    const h = hash(data);
    if (this.opts.isLogo(h)) return null;
    const ext = part.slice(part.lastIndexOf(".")).toLowerCase();
    const path = `${this.opts.attachmentsDir}/${h.slice(0, 12)}${ext}`;
    if (!this.out.has(path)) this.out.set(path, { path, hash: h, data });
    return `![[${path}]]`;
  }
}

export function hash(data: Uint8Array): string {
  return createHash("md5").update(data).digest("hex");
}
