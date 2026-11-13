import * as z from "zod/v4";

/** What Claude must return when filing a new document. */
export const IngestAnalysis = z.object({
  suitable: z.boolean(),
  reason: z.string(),
  folderPath: z.string(),
  topics: z.array(z.object({ name: z.string(), phrases: z.array(z.string()) })),
  newTopics: z.array(
    z.object({ name: z.string(), theme: z.string(), definition: z.string(), phrases: z.array(z.string()) }),
  ),
  relatedNotes: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type IngestAnalysis = z.infer<typeof IngestAnalysis>;
