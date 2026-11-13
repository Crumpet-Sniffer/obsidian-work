import { escapeRe } from "../connections";

export interface TopicPhrases {
  name: string;
  phrases: string[];
}

/**
 * Link the first mention of each topic's phrases in a note body to the topic page.
 * Headings, tables, callouts, embeds, URLs and existing links are never touched.
 */
export function addInlineLinks(body: string, topics: TopicPhrases[], topicsFolder: string): { body: string; added: number } {
  const lines = body.split("\n");
  let added = 0;
  for (const t of topics) {
    const phrases = [...new Set(t.phrases)].filter(Boolean).sort((a, b) => b.length - a.length);
    if (!phrases.length) continue;
    const rx = new RegExp(`(?<![\\w\\[/|#-])(${phrases.map(escapeRe).join("|")})(?![\\w\\]-])`, "gi");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim() || /^\s*(#|\||> \[!|!\[\[|---|%%)/.test(l) || l.includes("http") || (l.includes(">") && /<[a-z]/i.test(l))) continue;
      const spans = [...l.matchAll(/\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|`[^`]*`|\*\*/g)].map((m) => [m.index!, m.index! + m[0].length]);
      rx.lastIndex = 0;
      let hit: RegExpExecArray | null;
      let found: RegExpExecArray | null = null;
      while ((hit = rx.exec(l))) {
        if (!spans.some(([a, b]) => hit!.index >= a && hit!.index < b)) {
          found = hit;
          break;
        }
      }
      if (found) {
        lines[i] = l.slice(0, found.index) + `[[${topicsFolder}/${t.name}|${found[1]}]]` + l.slice(found.index + found[0].length);
        added++;
        break;
      }
    }
  }
  return { body: lines.join("\n"), added };
}

const topicLinkRx = (folder: string, flags = "g") => new RegExp(`\\[\\[${escapeRe(folder)}/([^\\]|]+)\\|`, flags);

/** Topic names listed on the "**Topics:**" line of a Connections block. */
export function topicsFromConnections(connections: string, topicsFolder: string): string[] {
  const line = connections.split("\n").find((l) => l.startsWith("**Topics:**"));
  return line ? [...line.matchAll(topicLinkRx(topicsFolder))].map((m) => m[1]) : [];
}

/** Topic names that are already linked inline in a body. */
export function inlineTopicNames(body: string, topicsFolder: string): string[] {
  return [...new Set([...body.matchAll(topicLinkRx(topicsFolder))].map((m) => m[1]))];
}

/** Turn topic links back into plain text (before re-converting or re-linking). */
export function stripTopicLinks(text: string, topicsFolder: string): string {
  return text.replace(new RegExp(`\\[\\[${escapeRe(topicsFolder)}/[^\\]|]+\\|([^\\]]+)\\]\\]`, "g"), "$1");
}
