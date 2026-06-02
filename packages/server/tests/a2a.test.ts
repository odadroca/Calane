import { A2AValidator } from "@llm-pipe/core";
import { describe, expect, it } from "vitest";
import {
  A2A_PROTOCOL_VERSION,
  buildAgentCard,
  inputFromMessage,
  loadVendoredA2ASchema,
  runResultToTask,
} from "../src/a2a.js";
import { TokenAuth } from "../src/auth.js";
import { buildServer } from "../src/server.js";

/** A validator bound to the vendored A2A schema bundle. */
function validator(): A2AValidator {
  return new A2AValidator(loadVendoredA2ASchema());
}

/** A minimal resolved pipeline stand-in for unit-level card construction. */
const RESOLVED = {
  spec: {
    id: "synthesis_consensus",
    name: "SWOT with consensus synthesis",
    version: "0.1.0",
    description: "SWOT strengths/weaknesses synthesized with the consensus variant.",
    providers: [{ id: "mock", type: "mock", model: "mock-model-1" }],
    channels: [{ id: "strengths", executionMode: "direct_provider", prompt: "p.md" }],
    synthesis: { id: "synthesis", executionMode: "direct_provider", prompt: "s.md" },
  },
  registry: "filesystem",
  ref: null,
  commitSha: null,
  pipelineHash: "abc",
} as unknown as Parameters<typeof buildAgentCard>[0];

describe("A2A vendored schema (R5)", () => {
  it("loads the vendored bundle and exposes the expected core definitions", () => {
    const v = validator();
    const names = v.definitionNames();
    for (const required of ["Agent Card", "Task", "Message", "Artifact", "Send Message Response"]) {
      expect(names).toContain(required);
    }
  });

  it("rejects an object that violates the Agent Card schema", () => {
    const v = validator();
    // additionalProperties:false in the vendored Agent Card -> bogus key invalid.
    const bad = v.validate("Agent Card", { name: "x", bogusField: 1 });
    expect(bad.valid).toBe(false);
  });
});

describe("buildAgentCard (R5)", () => {
  it("produces a card that validates against the vendored Agent Card schema", () => {
    const v = validator();
    const card = buildAgentCard(RESOLVED, {
      baseUrl: "https://calane.example",
      authEnforced: true,
    });
    const result = v.validate("Agent Card", card);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("HONESTLY declares synchronous, non-streaming capabilities", () => {
    const card = buildAgentCard(RESOLVED, { baseUrl: "https://x", authEnforced: false }) as {
      capabilities: { streaming: boolean; pushNotifications: boolean };
    };
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
  });

  it("maps PipelineSpec fields into the card and advertises the JSON-RPC interface", () => {
    const card = buildAgentCard(RESOLVED, {
      baseUrl: "https://calane.example",
      authEnforced: true,
    }) as Record<string, any>;
    expect(card.name).toBe("SWOT with consensus synthesis");
    expect(card.version).toBe("0.1.0");
    expect(card.skills[0].id).toBe("synthesis_consensus");
    expect(card.skills[0].outputModes).toEqual(["application/json"]);
    expect(card.supportedInterfaces[0].url).toBe("https://calane.example/a2a/synthesis_consensus");
    expect(card.supportedInterfaces[0].protocolBinding).toBe("JSONRPC");
    expect(card.supportedInterfaces[0].protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    // Bearer security declared only when auth is enforced.
    expect(card.securitySchemes.bearerAuth.httpAuthSecurityScheme.scheme).toBe("bearer");
  });

  it("omits security declarations when auth is not enforced (honest)", () => {
    const card = buildAgentCard(RESOLVED, { baseUrl: "https://x", authEnforced: false }) as Record<
      string,
      unknown
    >;
    expect(card.securitySchemes).toBeUndefined();
    expect(card.securityRequirements).toBeUndefined();
  });
});

describe("runResultToTask (R5)", () => {
  it("maps a completed run to a COMPLETED Task with the synthesis artifact", () => {
    const v = validator();
    const task = runResultToTask({
      runId: "run-1",
      status: "completed",
      synthesis: { channelId: "synthesis", parsedOutput: { verdict: "ok" } },
    });
    const result = v.validate("Task", task);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect((task.status as { state: string }).state).toBe("TASK_STATE_COMPLETED");
    expect((task.artifacts as any[])[0].parts[0].data).toEqual({ verdict: "ok" });
  });

  it("maps a failed run to a FAILED Task", () => {
    const task = runResultToTask({ runId: "r", status: "failed", synthesis: null });
    expect((task.status as { state: string }).state).toBe("TASK_STATE_FAILED");
  });

  it("extracts input text from an A2A message's parts", () => {
    expect(inputFromMessage({ parts: [{ text: "analyze ACME" }] })).toBe("analyze ACME");
    expect(inputFromMessage({ parts: [{ data: { q: 1 } }] })).toBe('{"q":1}');
    expect(inputFromMessage(undefined)).toBe("");
  });
});

describe("A2A well-known + invocation routes (R5)", () => {
  it("serves the index AgentCard publicly at /.well-known/agent-card.json", async () => {
    const v = validator();
    const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret" } as NodeJS.ProcessEnv });
    const app = buildServer({ logger: false, auth });
    const res = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    expect(res.statusCode).toBe(200); // public discovery, no token
    const card = res.json();
    expect(v.validate("Agent Card", card).valid).toBe(true);
    expect(card.capabilities.streaming).toBe(false);
    expect(Array.isArray(card.skills)).toBe(true);
    await app.close();
  });

  it("serves a per-pipeline AgentCard that validates against the vendored schema", async () => {
    const v = validator();
    const app = buildServer({ logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/agent-card/synthesis_consensus",
    });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(v.validate("Agent Card", card).valid).toBe(true);
    expect(card.skills[0].id).toBe("synthesis_consensus");
    await app.close();
  });

  it("404s the per-pipeline card for an unknown pipeline", async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/.well-known/agent-card/no-such" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("invokes a pipeline via JSON-RPC message/send and returns a COMPLETED Task", async () => {
    const v = validator();
    const app = buildServer({ logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/a2a/synthesis_consensus",
      payload: {
        jsonrpc: "2.0",
        id: "req-1",
        method: "message/send",
        params: {
          message: { role: "ROLE_USER", messageId: "m1", parts: [{ text: "Analyze ACME Corp" }] },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("req-1");
    // The JSON-RPC result is an A2A Send Message Response carrying the task.
    expect(v.validate("Send Message Response", body.result).valid).toBe(true);
    expect(v.validate("Task", body.result.task).valid).toBe(true);
    expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(body.result.task.artifacts.length).toBeGreaterThan(0);
    await app.close();
  });

  it("rejects a non-message/send method (synchronous-only)", async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/a2a/synthesis_consensus",
      payload: { jsonrpc: "2.0", id: 1, method: "message/stream", params: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(-32601);
    await app.close();
  });

  it("404s invocation for an unknown pipeline", async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/a2a/no-such-pipeline",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { role: "ROLE_USER", messageId: "m", parts: [{ text: "hi" }] } },
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("requires auth on invocation when a token is configured (401 without bearer)", async () => {
    const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret" } as NodeJS.ProcessEnv });
    const app = buildServer({ logger: false, auth });
    const res = await app.inject({
      method: "POST",
      url: "/a2a/synthesis_consensus",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { role: "ROLE_USER", messageId: "m", parts: [{ text: "hi" }] } },
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts invocation with a valid bearer token", async () => {
    const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret" } as NodeJS.ProcessEnv });
    const app = buildServer({ logger: false, auth });
    const res = await app.inject({
      method: "POST",
      url: "/a2a/synthesis_consensus",
      headers: { authorization: "Bearer secret" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { role: "ROLE_USER", messageId: "m", parts: [{ text: "hi" }] } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.task.status.state).toBe("TASK_STATE_COMPLETED");
    await app.close();
  });
});
