import type { ProviderAdapterInterface, ProviderRequest, ProviderResponse } from "@llm-pipe/core";

/** Parse a Retry-After header value (seconds or HTTP date) into ms. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

export interface OpenAICompatibleProviderOptions {
  /** Max automatic retries on HTTP 429 (default 3). */
  maxRateLimitRetries?: number;
  /** Backoff used when no Retry-After header is present (ms; default 1000). */
  defaultBackoffMs?: number;
  /** Inject a sleep fn (for tests); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Inject fetch (for tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch-based adapter for any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, Ollama, LiteLLM, Portkey, etc.). Credentials are read from the env
 * var named by ProviderSpec.apiKeyEnv (default OPENAI_API_KEY) and never
 * persisted. baseUrl defaults to https://api.openai.com/v1.
 *
 * On HTTP 429 the adapter backs off using the `Retry-After` header where present
 * (falling back to an exponential default) and retries up to `maxRateLimitRetries`.
 */
export class OpenAICompatibleProvider implements ProviderAdapterInterface {
  readonly type = "openai-compatible";

  constructor(private readonly opts: OpenAICompatibleProviderOptions = {}) {}

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const { spec } = request;
    const baseUrl = (spec.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKeyEnv = spec.apiKeyEnv ?? "OPENAI_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    const model = spec.model ?? "gpt-4.1-mini";

    if (!apiKey) {
      throw new Error(`Missing API key: env var ${apiKeyEnv} is not set`);
    }

    // Compose timeout + external cancellation into one signal.
    const timeoutMs = request.timeoutMs ?? spec.timeoutMs ?? 120_000;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    const signals = [timeoutCtrl.signal, request.signal].filter(Boolean) as AbortSignal[];
    const signal =
      typeof (AbortSignal as any).any === "function"
        ? (AbortSignal as any).any(signals)
        : timeoutCtrl.signal;

    const wantsJson = Boolean(request.outputSchema);
    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(wantsJson
          ? [{ role: "system", content: "Respond with a single valid JSON object only." }]
          : []),
        { role: "user", content: request.prompt },
      ],
      ...(spec.options ?? {}),
    };
    if (wantsJson) body.response_format = { type: "json_object" };

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const maxRetries = this.opts.maxRateLimitRetries ?? 3;
    const defaultBackoffMs = this.opts.defaultBackoffMs ?? 1000;

    try {
      let res!: Response;
      for (let attempt = 0; ; attempt++) {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        // Rate-limit backoff: honor Retry-After where present, else exponential.
        if (res.status === 429 && attempt < maxRetries) {
          const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
          const backoffMs = retryAfterMs ?? defaultBackoffMs * 2 ** attempt;
          await sleep(backoffMs);
          continue;
        }
        break;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`provider_error ${res.status}: ${text.slice(0, 500)}`);
      }

      const json: any = await res.json();
      const choice = json.choices?.[0];
      const rawOutput: string = choice?.message?.content ?? "";
      const finishReason: string | undefined = choice?.finish_reason;
      const refused = choice?.message?.refusal != null || finishReason === "content_filter";

      return {
        rawOutput,
        model: json.model ?? model,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? null,
          outputTokens: json.usage?.completion_tokens ?? null,
          costUsd: null,
        },
        refused,
        metadata: { finishReason },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
