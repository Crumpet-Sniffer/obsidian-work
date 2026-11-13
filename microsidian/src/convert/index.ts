import JSZip from "jszip";
import { convertDocx } from "./docx";
import { convertPptx } from "./pptx";
import type { ConvertOptions, ConvertResult } from "./types";

export * from "./types";

/** Convert a .docx or .pptx file (as bytes) into Markdown plus the images it should embed. */
export async function convertOffice(
  data: ArrayBuffer | Uint8Array,
  ext: string,
  opts: ConvertOptions,
): Promise<ConvertResult> {
  const zip = await JSZip.loadAsync(data);
  const e = ext.toLowerCase().replace(/^\./, "");
  if (e === "docx") return convertDocx(zip, opts);
  if (e === "pptx") return convertPptx(zip, opts);
  throw new Error(`Unsupported file type: .${e}`);
}
