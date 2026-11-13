import type Microsidian from "../main";
import type { Catalogue } from "./catalogue";
import { AnalyseOutcome, callClaude } from "./claude";
import { obsidianFetch } from "./obsidianFetch";

export { MODEL, estimate, explainError } from "./claude";
export type { AnalyseOutcome } from "./claude";

export function apiKey(plugin: Microsidian): string | null {
  const secret = plugin.app.secretStorage.getSecret(plugin.settings.apiKeySecretId);
  return secret || process.env.ANTHROPIC_API_KEY || null;
}

export async function analyseDocument(
  plugin: Microsidian,
  catalogue: Catalogue,
  fileName: string,
  documentText: string,
): Promise<AnalyseOutcome> {
  const key = apiKey(plugin);
  if (!key) throw new Error("No Anthropic API key is set. Add one in the Microsidian settings.");
  return callClaude({
    apiKey: key,
    fetch: obsidianFetch as unknown as typeof fetch,
    effort: plugin.settings.effort,
    catalogue,
    guidance: plugin.settings.guidance,
    fileName,
    documentText,
  });
}
