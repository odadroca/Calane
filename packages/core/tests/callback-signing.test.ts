import { describe, expect, it } from "vitest";
import { executeChannel } from "../src/executor/ChannelExecutor.js";
import { PromptRenderer } from "../src/rendering/PromptRenderer.js";
import { InMemoryCallbackSecretStore } from "../src/security/CallbackSecretStore.js";
import {
  type CallbackPayload,
  generateNonce,
  nonceKey,
  signCallback,
  verifyCallback,
} from "../src/security/CallbackSigning.js";
import { JsonSchemaValidator } from "../src/validation/JsonSchemaValidator.js";

const secret = "a".repeat(64);

function payload(overrides: Partial<CallbackPayload> = {}): CallbackPayload {
  return {
    runId: "run_1",
    channelId: "delegated",
    nonce: generateNonce(),
    timestamp: new Date().toISOString(),
    result: { ok: true },
    ...overrides,
  };
}

describe("verifyCallback", () => {
  it("accepts a valid signature within the window", () => {
    const p = payload();
    const sig = signCallback(secret, p);
    expect(verifyCallback({ secret, payload: p, signature: sig })).toEqual({ valid: true });
  });

  it("rejects a missing signature", () => {
    const p = payload();
    expect(verifyCallback({ secret, payload: p, signature: null })).toEqual({
      valid: false,
      reason: "missing",
    });
  });

  it("rejects an invalid signature (tampered result)", () => {
    const p = payload();
    const sig = signCallback(secret, p);
    const tampered = { ...p, result: { ok: false } };
    expect(verifyCallback({ secret, payload: tampered, signature: sig })).toEqual({
      valid: false,
      reason: "invalid",
    });
  });

  it("rejects an expired callback (timestamp outside the window)", () => {
    const old = payload({ timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
    const sig = signCallback(secret, old);
    expect(verifyCallback({ secret, payload: old, signature: sig })).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  it("rejects a replayed nonce", () => {
    const p = payload();
    const sig = signCallback(secret, p);
    const seen = new Set<string>([nonceKey(p)]);
    expect(
      verifyCallback({ secret, payload: p, signature: sig, isNonceSeen: (k) => seen.has(k) }),
    ).toEqual({ valid: false, reason: "replayed" });
  });
});

describe("delegated-agent dispatch + callback round-trip", () => {
  it("mints a per-channel secret on dispatch, then verifies the agent's signed callback", async () => {
    const secretStore = new InMemoryCallbackSecretStore();
    const runId = "run_roundtrip";

    // Dispatch a delegated-agent channel; a resolver acts as the external agent.
    const planned = {
      channel: { id: "delegated", executionMode: "delegated_agent" as const, prompt: "ignored" },
      provider: { id: "agent", type: "delegated-agent" },
      isSynthesis: false,
    };
    const adapter = {
      type: "delegated-agent",
      async execute() {
        return {
          rawOutput: JSON.stringify({ note: "dispatched" }),
          model: null,
          usage: { inputTokens: null, outputTokens: null, costUsd: null },
        };
      },
    };
    const store = {
      name: "mem",
      async saveRun() {},
      async getRun() {
        return null;
      },
      async listRuns() {
        return [];
      },
      async saveRawOutput(_r: string, key: string) {
        return `raw/${key}.txt`;
      },
      async getRawOutput() {
        return null;
      },
    };

    await executeChannel(planned, {
      adapter,
      renderer: new PromptRenderer(),
      validator: new JsonSchemaValidator(),
      store,
      runId,
      promptTemplate: "do work",
      schema: null,
      context: { input: "x" },
      secretStore,
    });

    // The dispatch persisted a per-channel secret.
    const minted = await secretStore.get(runId, "delegated");
    expect(minted).toMatch(/^[0-9a-f]{64}$/);

    // The external agent signs its callback with that secret.
    const p = payload({ runId, channelId: "delegated", result: { dimension: "ok" } });
    const sig = signCallback(minted!, p);

    const first = verifyCallback({ secret: minted!, payload: p, signature: sig });
    expect(first).toEqual({ valid: true });
    // Consume the nonce; a second presentation is a replay.
    const replayed = await secretStore.markNonceSeen(nonceKey(p));
    expect(replayed).toBe(false);
    expect(await secretStore.markNonceSeen(nonceKey(p))).toBe(true);
  });
});
