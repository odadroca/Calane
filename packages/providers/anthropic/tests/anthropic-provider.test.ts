import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ProviderRequest } from "@llm-pipe/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AnthropicMessageResponse,
  type AnthropicMessagesClient,
  AnthropicProvider,
} from "../src/AnthropicProvider.js";
import { computeCostUsd, priceForModel } from "../src/pricing.js";

function loadFixture(name: string): AnthropicMessageResponse {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as AnthropicMessageResponse;
}

/** A fake client that records the request body and replays a recorded fixture. */
function fakeClient(fixture: AnthropicMessageResponse): {
  client: AnthropicMessagesClient;
  lastBody: () => Record<string, unknown> | null;
} {
  let captured: Record<string, unknown> | null = null;
  return {
    client: {
      messages: {
        async create(body) {
          captured = body;
          return fixture;
        },
      },
    },
    lastBody: () => captured,
  };
}

const baseSpec = { id: "anthropic", type: "anthropic", model: "claude-opus-4-7" };
function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: "run_test",
    channelId: "strengths",
    prompt: "Analyze the subject.",
    spec: baseSpec,
    ...overrides,
  };
}

const channelSchema = {
  type: "object",
  required: ["dimension", "claims"],
  properties: {
    dimension: { type: "string" },
    claims: { type: "array", items: { type: "object" } },
  },
};

describe("AnthropicProvider", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) {
      process.env.ANTHROPIC_API_KEY = "";
    } else {
      process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("extracts structured output from a tool_use block (recorded fixture)", async () => {
    const { client, lastBody } = fakeClient(loadFixture("structured-response.json"));
    const provider = new AnthropicProvider({ client });
    const res = await provider.execute(req({ outputSchema: channelSchema }));

    const parsed = JSON.parse(res.rawOutput);
    expect(parsed.dimension).toBe("strengths");
    expect(parsed.claims).toHaveLength(1);
    // tool_use path: schema registered as a tool, tool_choice forces it.
    const body = lastBody()!;
    expect((body.tool_choice as { name: string }).name).toBe("emit_structured_output");
    expect((body.tools as unknown[]).length).toBe(1);
  });

  it("returns input/output token usage and a computed costUsd", async () => {
    const { client } = fakeClient(loadFixture("structured-response.json"));
    const res = await new AnthropicProvider({ client }).execute(
      req({ outputSchema: channelSchema }),
    );
    expect(res.usage.inputTokens).toBe(412);
    expect(res.usage.outputTokens).toBe(96);
    // 412/1e6*5 + 96/1e6*25 = 0.00206 + 0.0024 = 0.00446
    expect(res.usage.costUsd).toBeCloseTo(0.00446, 8);
  });

  it("concatenates text blocks when no schema is requested", async () => {
    const { client, lastBody } = fakeClient(loadFixture("text-response.json"));
    const res = await new AnthropicProvider({ client }).execute(req());
    expect(res.rawOutput).toBe("Here is a plain text answer.");
    expect(lastBody()!.tools).toBeUndefined();
  });

  it("flags refusals", async () => {
    const { client } = fakeClient(loadFixture("refusal-response.json"));
    const res = await new AnthropicProvider({ client }).execute(req());
    expect(res.refused).toBe(true);
  });

  it("throws a clear error when the API key env var is missing", async () => {
    // No injected client -> tries to read env; ensure it is empty (falsy).
    process.env.ANTHROPIC_API_KEY = "";
    const provider = new AnthropicProvider();
    await expect(provider.execute(req())).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("passes the model identifier through provider config", async () => {
    const { client, lastBody } = fakeClient(loadFixture("text-response.json"));
    await new AnthropicProvider({ client }).execute(
      req({ spec: { id: "a", type: "anthropic", model: "claude-sonnet-4-6" } }),
    );
    expect(lastBody()!.model).toBe("claude-sonnet-4-6");
  });

  it("pricing table resolves dated snapshots by prefix", () => {
    expect(priceForModel("claude-haiku-4-5-20251001")?.inputPerMTok).toBe(1);
    expect(computeCostUsd("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    expect(computeCostUsd("unknown-model", 100, 100)).toBeNull();
  });
});
