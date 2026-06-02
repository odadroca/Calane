import Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapterInterface, ProviderRequest, ProviderResponse } from "@llm-pipe/core";
import { type ModelPrice, computeCostUsd } from "./pricing.js";

/**
 * Minimal shape of the Anthropic Messages client this adapter depends on. The
 * real `@anthropic-ai/sdk` client satisfies it; tests inject a fake that replays
 * a recorded fixture so no live API call is made.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(body: Record<string, unknown>): Promise<AnthropicMessageResponse>;
  };
}

export interface AnthropicMessageResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [k: string]: unknown }
  >;
  model?: string;
  stop_reason?: string | null;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
}

export interface AnthropicProviderOptions {
  /** Inject a client (for tests/fixtures). When omitted, a real SDK client is built per request. */
  client?: AnthropicMessagesClient;
  /** Override the hardcoded pricing table. */
  pricing?: Record<string, ModelPrice>;
  /** Max automatic retries on HTTP 429 (default 3). */
  maxRateLimitRetries?: number;
  /** Backoff used when no Retry-After header is present (ms; default 1000). */
  defaultBackoffMs?: number;
  /** Inject a sleep fn (for tests); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Parse a Retry-After header value (seconds or HTTP date) into ms. */
export function parseRetryAfterMs(value: unknown, now = Date.now()): number | null {
  if (value === null || value === undefined) return null;
  const str = String(value);
  const seconds = Number(str);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(str);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

/** Extract a 429 status + Retry-After header from an SDK error, if present. */
function rateLimitInfo(err: unknown): { is429: boolean; retryAfterMs: number | null } {
  const e = err as { status?: number; headers?: Record<string, unknown> } | undefined;
  const is429 = e?.status === 429;
  const header = e?.headers?.["retry-after"] ?? e?.headers?.["Retry-After"];
  return { is429, retryAfterMs: parseRetryAfterMs(header) };
}

const STRUCTURED_TOOL_NAME = "emit_structured_output";

/**
 * Anthropic provider conforming to ProviderAdapterInterface. Reads the API key
 * from the env var named by ProviderSpec.apiKeyEnv (default ANTHROPIC_API_KEY)
 * and never persists it. When a JSON Schema output is requested, it uses
 * Anthropic's `tool_use` content blocks to extract structured output: the schema
 * is registered as a single tool and `tool_choice` forces its use; the returned
 * `tool_use.input` is serialized to JSON as the raw output. Otherwise the model's
 * text blocks are concatenated.
 */
export class AnthropicProvider implements ProviderAdapterInterface {
  readonly type = "anthropic";

  constructor(private readonly options: AnthropicProviderOptions = {}) {}

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const { spec } = request;
    const model = spec.model ?? "claude-opus-4-7";
    const apiKeyEnv = spec.apiKeyEnv ?? "ANTHROPIC_API_KEY";

    const client = this.options.client ?? this.buildClient(apiKeyEnv, spec.baseUrl);

    const wantsStructured = Boolean(request.outputSchema);
    const maxTokens = (spec.options?.maxTokens as number | undefined) ?? 4096;

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: request.prompt }],
      ...(spec.options?.system ? { system: spec.options.system } : {}),
    };

    if (wantsStructured) {
      body.tools = [
        {
          name: STRUCTURED_TOOL_NAME,
          description:
            "Return the analysis as a single structured object conforming to the provided JSON Schema.",
          input_schema: request.outputSchema,
        },
      ];
      body.tool_choice = { type: "tool", name: STRUCTURED_TOOL_NAME };
    }

    // Rate-limit backoff: retry on HTTP 429, honoring Retry-After where present.
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const maxRetries = this.options.maxRateLimitRetries ?? 3;
    const defaultBackoffMs = this.options.defaultBackoffMs ?? 1000;
    let response: AnthropicMessageResponse;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await client.messages.create(body);
        break;
      } catch (err) {
        const { is429, retryAfterMs } = rateLimitInfo(err);
        if (is429 && attempt < maxRetries) {
          await sleep(retryAfterMs ?? defaultBackoffMs * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }

    const refused = response.stop_reason === "refusal";
    const rawOutput = extractRawOutput(response, wantsStructured);

    const inputTokens = response.usage?.input_tokens ?? null;
    const outputTokens = response.usage?.output_tokens ?? null;
    const respModel = response.model ?? model;

    return {
      rawOutput,
      model: respModel,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(respModel, inputTokens, outputTokens, this.options.pricing),
      },
      refused,
      metadata: { stopReason: response.stop_reason ?? null },
    };
  }

  private buildClient(apiKeyEnv: string, baseUrl?: string): AnthropicMessagesClient {
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Missing API key: env var ${apiKeyEnv} is not set`);
    }
    const sdk = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
    // The SDK client's create() returns a richer type; narrow to the subset this
    // adapter consumes. Field names match the API response shape verbatim.
    return sdk as unknown as AnthropicMessagesClient;
  }
}

/**
 * Build the raw output string. For structured requests, serialize the first
 * tool_use block's input. Otherwise concatenate text blocks. Raw output is always
 * returned (even on refusal) so it can be persisted.
 */
function extractRawOutput(response: AnthropicMessageResponse, wantsStructured: boolean): string {
  if (wantsStructured) {
    const toolUse = response.content.find(
      (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
        b.type === "tool_use",
    );
    if (toolUse) return JSON.stringify(toolUse.input);
  }
  const text = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  return text;
}
