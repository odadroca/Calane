import { type Static, Type } from "@sinclair/typebox";

/**
 * A provider declaration inside a pipeline. `type` selects which registered
 * ProviderAdapter handles execution (e.g. "openai-compatible", "mock",
 * "delegated-agent"). Credentials are NEVER stored here — they are resolved
 * from environment variables by the adapter at execution time.
 */
export const ProviderSpec = Type.Object(
  {
    id: Type.String({ description: "Caller-facing provider id used in channels." }),
    type: Type.String({ description: "Adapter type key registered in the provider registry." }),
    model: Type.Optional(Type.String()),
    baseUrl: Type.Optional(Type.String()),
    /** Name of the env var holding the API key. The value is never persisted. */
    apiKeyEnv: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
    /** Free-form provider options forwarded to the adapter. */
    options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { $id: "ProviderSpec", additionalProperties: false },
);

export type ProviderSpec = Static<typeof ProviderSpec>;
