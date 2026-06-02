import type { ProviderRequest } from "@llm-pipe/core";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, parseRetryAfterMs } from "../src/OpenAICompatibleProvider.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const baseRequest = (): ProviderRequest => ({
  runId: "r1",
  channelId: "c1",
  prompt: "hi",
  spec: { id: "p", type: "openai-compatible", apiKeyEnv: "TEST_OAI_KEY" },
});

describe("parseRetryAfterMs", () => {
  it("parses seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
  });
  it("parses an HTTP date relative to now", () => {
    const now = Date.now();
    const future = new Date(now + 5000).toUTCString();
    const ms = parseRetryAfterMs(future, now);
    // toUTCString truncates to whole seconds; allow a 1s tolerance.
    expect(ms).toBeGreaterThanOrEqual(4000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
  it("returns null for missing/invalid", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });
});

describe("OpenAICompatibleProvider rate-limit backoff (S10)", () => {
  it("retries on 429 honoring Retry-After then succeeds", async () => {
    process.env.TEST_OAI_KEY = "test-key";
    const slept: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls <= 2) {
        return jsonResponse({ error: "rate limited" }, 429, { "retry-after": "3" });
      }
      return jsonResponse({
        model: "gpt-x",
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const res = await provider.execute(baseRequest());

    expect(calls).toBe(3);
    expect(slept).toEqual([3000, 3000]); // Retry-After: 3s, honored each 429
    expect(res.rawOutput).toBe('{"ok":true}');
  });

  it("falls back to exponential backoff when no Retry-After header", async () => {
    process.env.TEST_OAI_KEY = "test-key";
    const slept: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls <= 2) return jsonResponse({ error: "rate limited" }, 429);
      return jsonResponse({
        model: "gpt-x",
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: {},
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      fetchImpl,
      defaultBackoffMs: 100,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await provider.execute(baseRequest());
    expect(slept).toEqual([100, 200]); // exponential: 100 * 2^0, 100 * 2^1
  });

  it("gives up after maxRateLimitRetries and throws provider_error", async () => {
    process.env.TEST_OAI_KEY = "test-key";
    const fetchImpl = (async () =>
      jsonResponse({ error: "rate limited" }, 429, {
        "retry-after": "1",
      })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      fetchImpl,
      maxRateLimitRetries: 2,
      sleep: async () => {},
    });
    await expect(provider.execute(baseRequest())).rejects.toThrow(/provider_error 429/);
  });
});
