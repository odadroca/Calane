import type { RunResult } from "../specs/RunResult.js";

/**
 * ResultStoreInterface — a functional plugin that persists run metadata, raw
 * outputs, parsed outputs, and validation reports. Filesystem-first.
 */
export interface ResultStoreInterface {
  readonly name: string;
  saveRun(result: RunResult): Promise<void>;
  getRun(runId: string): Promise<RunResult | null>;
  listRuns(): Promise<string[]>;
  /** Persist a raw output blob, returning a store-relative reference. */
  saveRawOutput(runId: string, channelKey: string, raw: string): Promise<string>;
  getRawOutput(runId: string, rawOutputRef: string): Promise<string | null>;
}
