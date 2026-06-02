import { type Static, Type } from "@sinclair/typebox";

export const RunOptions = Type.Object(
  {
    /** Provider ids to use, overriding pipeline defaults where applicable. */
    providers: Type.Optional(Type.Array(Type.String())),
    /** Override recursion max depth. */
    depth: Type.Optional(Type.Number({ minimum: 0 })),
    maxConcurrency: Type.Optional(Type.Number({ minimum: 1 })),
    timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
    /** When exporting, redact obvious secrets from raw outputs. */
    exportRedacted: Type.Optional(Type.Boolean()),
    /**
     * Resume a prior partial run by id: completed channels are carried forward
     * unchanged and only the not-completed channels are re-executed. The prior
     * run's pipeline/prompt/schema hashes are verified before resuming.
     */
    resumeFromRunId: Type.Optional(Type.String()),
  },
  { $id: "RunOptions", additionalProperties: false },
);
export type RunOptions = Static<typeof RunOptions>;

export const RunRequest = Type.Object(
  {
    pipelineId: Type.String(),
    /** The analysis input text (e.g. the topic/document under analysis). */
    input: Type.String(),
    options: Type.Optional(RunOptions),
  },
  { $id: "RunRequest", additionalProperties: false },
);
export type RunRequest = Static<typeof RunRequest>;
