import type { PipelineSpec } from "../specs/PipelineSpec.js";

export interface ResolvedPipeline {
  spec: PipelineSpec;
  /** Where the pipeline came from: "filesystem" | "git" | other. */
  registry: string;
  /** Human-readable ref / path. */
  ref: string | null;
  /** Git commit SHA when applicable. */
  commitSha: string | null;
  /** Canonical hash of the resolved pipeline spec. */
  pipelineHash: string;
}

/**
 * PromptRegistryInterface — a functional plugin responsible for resolving
 * pipeline definitions, prompt templates, and JSON Schema files. The Git
 * registry is a thin extension of this contract.
 */
export interface PromptRegistryInterface {
  readonly name: string;
  listPipelines(): Promise<string[]>;
  resolvePipeline(pipelineId: string): Promise<ResolvedPipeline>;
  /** Load a prompt template's raw text by its registry-relative path. */
  loadPrompt(relativePath: string): Promise<string>;
  /** Load and parse a JSON Schema file by its registry-relative path. */
  loadSchema(relativePath: string): Promise<unknown>;
}
