import { DEFAULT_LAYOUT } from "./config";

export interface MicrosidianSettings {
  // --- folders ---
  ingestFolder: string;
  originalsFolder: string;
  attachmentsFolder: string;
  topicsFolder: string;
  /** Name of an optional note listing all topics; updated when it exists. */
  topicsIndexNote: string;
  // --- behaviour ---
  autoSyncOnModify: boolean;
  autoAcceptIngest: boolean;
  /** Add "<top folder> - Index" entries for filed notes when such an index note exists. */
  updateFolderIndexes: boolean;
  imageMinKB: number;
  effort: "low" | "medium" | "high";
  /** Your own rules for filing, added to the instructions Claude receives. */
  guidance: string;
  /** Name of the secret in Obsidian's secret storage that holds the Anthropic API key (the key itself is never saved here). */
  apiKeySecretId: string;
  /** image hash -> originals containing it (used to skip template logos). */
  imageIndex: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: MicrosidianSettings = {
  ingestFolder: DEFAULT_LAYOUT.ingest,
  originalsFolder: DEFAULT_LAYOUT.originals,
  attachmentsFolder: DEFAULT_LAYOUT.attachments,
  topicsFolder: DEFAULT_LAYOUT.topics,
  topicsIndexNote: DEFAULT_LAYOUT.topicsIndex,
  autoSyncOnModify: true,
  autoAcceptIngest: false,
  updateFolderIndexes: true,
  imageMinKB: 30,
  effort: "medium",
  guidance: "",
  apiKeySecretId: "anthropic-api-key",
  imageIndex: {},
};
