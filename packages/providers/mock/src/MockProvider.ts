import type { ProviderAdapterInterface, ProviderRequest, ProviderResponse } from "@llm-pipe/core";

/**
 * Deterministic mock provider for tests and offline CLI runs. When given an
 * output schema it synthesizes a schema-conforming JSON object so example
 * pipelines run end-to-end without network access.
 *
 * Provider options:
 *   mockMode: "valid" (default) | "invalid_json" | "schema_error" | "refused"
 */
export class MockProvider implements ProviderAdapterInterface {
  readonly type = "mock";

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const mode = (request.spec.options?.mockMode as string) ?? "valid";
    const model = request.spec.model ?? "mock-model-1";
    const usage = { inputTokens: request.prompt.length, outputTokens: 64, costUsd: 0 };

    if (mode === "refused") {
      return { rawOutput: "I cannot help with that request.", model, usage, refused: true };
    }
    if (mode === "invalid_json") {
      return { rawOutput: "not json at all — totally freeform prose", model, usage };
    }
    if (mode === "schema_error") {
      return { rawOutput: JSON.stringify({ unexpected: "shape" }), model, usage };
    }

    const synthesized = request.outputSchema
      ? synthesizeFromSchema(request.outputSchema, request.channelId)
      : { note: `mock response for channel ${request.channelId}` };

    return { rawOutput: JSON.stringify(synthesized, null, 2), model, usage };
  }
}

/** Walk a JSON Schema and produce a minimal conforming value. */
export function synthesizeFromSchema(schema: any, seed: string): unknown {
  if (!schema || typeof schema !== "object") return null;
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      const required: string[] = schema.required ?? Object.keys(props);
      for (const key of Object.keys(props)) {
        if (required.includes(key)) out[key] = synthesizeFromSchema(props[key], `${seed}.${key}`);
      }
      return out;
    }
    case "array": {
      const min = schema.minItems ?? 1;
      const item = schema.items ?? { type: "string" };
      return Array.from({ length: Math.max(1, min) }, (_, i) =>
        synthesizeFromSchema(item, `${seed}[${i}]`),
      );
    }
    case "number":
    case "integer":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    default:
      return `mock ${seed}`;
  }
}
