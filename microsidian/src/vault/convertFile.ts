import type { App, TFile } from "obsidian";
import type Microsidian from "../main";
import { convertOffice, ConvertResult } from "../convert";

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export async function writeImages(app: App, attachmentsDir: string, images: ConvertResult["images"]): Promise<number> {
  const ad = app.vault.adapter;
  let written = 0;
  if (images.length && !(await ad.exists(attachmentsDir))) await ad.mkdir(attachmentsDir);
  for (const img of images) {
    if (await ad.exists(img.path)) continue;
    await ad.writeBinary(img.path, toArrayBuffer(img.data));
    written++;
  }
  return written;
}

/** Convert an original from the vault, save its images and update the image index. */
export async function convertVaultFile(plugin: Microsidian, file: TFile): Promise<ConvertResult> {
  await plugin.imageIndex.ensureBuilt();
  const data = await plugin.app.vault.readBinary(file);
  const attachmentsDir = plugin.layout.attachments;
  const res = await convertOffice(data, file.extension, {
    imageMinBytes: plugin.settings.imageMinKB * 1000,
    isLogo: plugin.imageIndex.isLogo,
    attachmentsDir,
    originalPath: file.path,
  });
  await writeImages(plugin.app, attachmentsDir, res.images);
  plugin.imageIndex.update(file.path, res.imageHashes);
  await plugin.persistImageIndex();
  return res;
}
