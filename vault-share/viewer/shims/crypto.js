// Browser stand-in for the one thing Microsidian's converter uses from Node's "crypto": an MD5 of image bytes,
// which names extracted images. Same digest as Node's, so image names match the Obsidian plugin's.
import { md5 } from "js-md5";

export function createHash() {
  const h = md5.create();
  return {
    update(data) { h.update(data); return this; },
    digest() { return h.hex(); },
  };
}
