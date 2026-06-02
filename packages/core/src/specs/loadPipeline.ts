import { Value } from "@sinclair/typebox/value";
import { parse as parseYaml } from "yaml";
import { PipelineSpec } from "./PipelineSpec.js";

/**
 * Parse + validate a pipeline definition from YAML or JSON text against the
 * TypeBox PipelineSpec (single source of truth). Throws with readable errors.
 */
export function parsePipeline(text: string): PipelineSpec {
  const raw = parseYaml(text);
  const errors = [...Value.Errors(PipelineSpec, raw)];
  if (errors.length > 0) {
    const summary = errors
      .slice(0, 10)
      .map((e) => `  ${e.path || "/"}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid pipeline spec:\n${summary}`);
  }
  return raw as PipelineSpec;
}

/** Validate an already-parsed object, returning the typed spec or error list. */
export function validatePipelineObject(obj: unknown): {
  valid: boolean;
  errors: { path: string; message: string }[];
  spec: PipelineSpec | null;
} {
  const errors = [...Value.Errors(PipelineSpec, obj)].map((e) => ({
    path: e.path || "/",
    message: e.message,
  }));
  return {
    valid: errors.length === 0,
    errors,
    spec: errors.length === 0 ? (obj as PipelineSpec) : null,
  };
}
