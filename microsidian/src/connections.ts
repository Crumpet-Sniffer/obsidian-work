import { CONN_END, CONN_START } from "./constants";

/** Text of the auto-generated Connections block of a note (without markers or heading), or null. */
export function extractConnections(markdown: string): string | null {
  const a = markdown.indexOf(CONN_START);
  const b = markdown.indexOf(CONN_END);
  if (a < 0 || b < 0 || b < a) return null;
  let block = markdown.slice(a + CONN_START.length, b).trim();
  block = block.replace(/^---\s*\n/, "").replace(/^##\s+Connections\s*\n/, "").trim();
  return block || null;
}

/** Remove the Connections block (and surrounding blank lines) from a note. */
export function stripConnections(markdown: string): string {
  const re = new RegExp(`\\n*${escapeRe(CONN_START)}[\\s\\S]*?${escapeRe(CONN_END)}\\n*`, "g");
  return markdown.replace(re, "\n").replace(/\s+$/, "") + "\n";
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
