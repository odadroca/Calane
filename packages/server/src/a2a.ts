/**
 * A2A AgentCard exposure (Phase 7 / R5).
 *
 * Exposes each declared Calane pipeline to Agent2Agent (A2A) clients, conforming
 * to the VENDORED A2A schema bundle at `vendor/a2a/a2a.schema.json` (an undated,
 * version-less snapshot supplied by the operator — see vendor/a2a/PROVENANCE.md).
 * Everything emitted here (AgentCard, Task/Message responses) is validated against
 * that vendored schema by tests; this module invents no fields outside it.
 *
 * HONEST capability declaration: Calane is an explicit-loop, single-shot
 * `run_pipeline` kernel — NOT an agent-managed task lifecycle. The AgentCard
 * therefore declares `streaming: false` and `pushNotifications: false`, and an
 * invocation maps to EXACTLY ONE `run_pipeline` returning a single COMPLETED Task
 * carrying the run's synthesis as the artifact. No long-running / streaming /
 * push-notification capability is advertised.
 *
 * Scope: REST + `.well-known` endpoints ONLY. The 8-tool MCP/openai surface is
 * frozen and untouched.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { A2ASchemaBundle, ResolvedPipeline } from "@llm-pipe/core";
import type { FastifyInstance } from "fastify";
import type { Kernel } from "./kernel.js";

/**
 * A2A protocol version advertised by this server's interface. The vendored
 * bundle carries `version: "v1"` at its top level (no semver release tag); we
 * echo that string and treat the file as a pinned dated snapshot. See
 * docs/a2a.md and vendor/a2a/PROVENANCE.md.
 */
export const A2A_PROTOCOL_VERSION = "v1";

/** Walk up from a starting directory to find the vendored A2A schema bundle. */
function findVendoredSchemaPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "vendor", "a2a", "a2a.schema.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("vendored A2A schema not found (vendor/a2a/a2a.schema.json)");
}

let cachedBundle: A2ASchemaBundle | undefined;

/** Load + cache the vendored A2A schema bundle from disk. */
export function loadVendoredA2ASchema(): A2ASchemaBundle {
  if (!cachedBundle) {
    cachedBundle = JSON.parse(readFileSync(findVendoredSchemaPath(), "utf8")) as A2ASchemaBundle;
  }
  return cachedBundle;
}

export interface AgentCardOptions {
  /** Public base URL of the deployed server (for the interface URL + invocation). */
  baseUrl: string;
  /** Whether the kernel currently enforces auth on the invocation endpoint. */
  authEnforced: boolean;
}

/**
 * Build an A2A AgentCard for a single resolved pipeline. Fields present in the
 * PipelineSpec map straight in; A2A-required fields Calane lacks get honest
 * defaults. The card conforms to the vendored "Agent Card" definition.
 */
export function buildAgentCard(
  resolved: ResolvedPipeline,
  options: AgentCardOptions,
): Record<string, unknown> {
  const { spec } = resolved;
  const base = options.baseUrl.replace(/\/+$/, "");
  const skillTags = Array.from(new Set(spec.providers.map((p) => p.type)));

  // One A2A skill per pipeline: the pipeline IS the agent's single capability.
  const skill: Record<string, unknown> = {
    id: spec.id,
    name: spec.name ?? spec.id,
    description: spec.description ?? `Run the ${spec.id} analysis pipeline.`,
    tags: skillTags.length > 0 ? skillTags : ["pipeline"],
    inputModes: ["text/plain"],
    // Synthesis output is structured JSON when a synthesis channel is present.
    outputModes: [spec.synthesis ? "application/json" : "text/plain"],
  };

  const card: Record<string, unknown> = {
    name: spec.name ?? spec.id,
    description:
      spec.description ?? `Calane pipeline "${spec.id}" exposed as a synchronous A2A agent.`,
    // The pipeline's own version doubles as the agent version.
    version: spec.version,
    provider: {
      organization: "Calane (llm-pipeline-kernel)",
      url: base,
    },
    // HONEST capabilities: explicit-loop single-shot, no streaming / push.
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: [spec.synthesis ? "application/json" : "text/plain"],
    skills: [skill],
    // One JSON-RPC interface: the synchronous message/send invocation endpoint.
    supportedInterfaces: [
      {
        url: `${base}/a2a/${encodeURIComponent(spec.id)}`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
  };

  // Declare bearer auth only when the kernel actually enforces it (honest).
  if (options.authEnforced) {
    card.securitySchemes = {
      bearerAuth: { httpAuthSecurityScheme: { scheme: "bearer" } },
    };
    card.securityRequirements = [{ schemes: { bearerAuth: { list: [] } } }];
  }

  return card;
}

/** Extract a plain input string from an A2A message's parts (text parts joined). */
export function inputFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const part of parts) {
    if (part && typeof part === "object") {
      const p = part as { text?: unknown; data?: unknown };
      if (typeof p.text === "string") texts.push(p.text);
      else if (p.data !== undefined) texts.push(JSON.stringify(p.data));
    }
  }
  return texts.join("\n");
}

/**
 * Map a completed Calane RunResult to a single COMPLETED A2A Task carrying the
 * run's synthesis as an artifact. Conforms to the vendored Task/Artifact/Part/
 * TaskStatus definitions. A failed/partial run maps to TASK_STATE_FAILED.
 */
export function runResultToTask(run: {
  runId: string;
  status: string;
  synthesis: { parsedOutput?: unknown; channelId?: string } | null;
}): Record<string, unknown> {
  const completed = run.status === "completed";
  const state = completed ? "TASK_STATE_COMPLETED" : "TASK_STATE_FAILED";

  const task: Record<string, unknown> = {
    id: run.runId,
    contextId: run.runId,
    status: {
      state,
      timestamp: new Date().toISOString(),
    },
  };

  if (run.synthesis && run.synthesis.parsedOutput !== undefined) {
    const parsed = run.synthesis.parsedOutput;
    const part =
      typeof parsed === "string"
        ? { text: parsed, mediaType: "text/plain" }
        : { data: parsed as unknown, mediaType: "application/json" };
    task.artifacts = [
      {
        artifactId: `${run.runId}-synthesis`,
        name: "synthesis",
        description: "The pipeline's synthesized result.",
        parts: [part],
      },
    ];
  }
  return task;
}

/** A minimal JSON-RPC 2.0 error object. */
function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Register the A2A surface:
 *   - GET /.well-known/agent-card.json        — index card (lists per-pipeline cards)
 *   - GET /.well-known/agent-card/:pipelineId — per-pipeline AgentCard
 *   - POST /a2a/:pipelineId                    — JSON-RPC message/send -> run_pipeline
 *
 * Discovery (the well-known cards) is public; invocation rides the existing REST
 * auth hook (so it requires a valid bearer / OAuth token when auth is enforced).
 */
export function registerA2ARoutes(
  app: FastifyInstance,
  kernel: Kernel,
  opts: { authEnforced: boolean },
): void {
  const baseUrl = () =>
    (process.env.CALANE_PUBLIC_URL ?? "http://localhost:8787").replace(/\/+$/, "");

  const cardOptions = (): AgentCardOptions => ({
    baseUrl: baseUrl(),
    authEnforced: opts.authEnforced,
  });

  // Index AgentCard at the current A2A well-known convention path. Calane hosts
  // MANY pipelines, so the canonical card points at per-pipeline cards via the
  // `additionalInterfaces`-style list under `supportedInterfaces`; the per-
  // pipeline cards (below) are the invocable agents.
  app.get("/.well-known/agent-card.json", async (_req, reply) => {
    const ids = await kernel.registry.listPipelines();
    const base = baseUrl();
    reply.header("content-type", "application/json");
    return {
      name: "Calane (llm-pipeline-kernel)",
      description:
        "Calane exposes each declared pipeline as a synchronous, non-streaming " +
        "A2A agent. Fetch a per-pipeline AgentCard to invoke it.",
      version: A2A_PROTOCOL_VERSION,
      provider: { organization: "Calane (llm-pipeline-kernel)", url: base },
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["application/json"],
      skills: ids.map((id) => ({
        id,
        name: id,
        description: `Run the ${id} pipeline.`,
        tags: ["pipeline"],
      })),
      supportedInterfaces: ids.map((id) => ({
        url: `${base}/.well-known/agent-card/${encodeURIComponent(id)}`,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
      })),
    };
  });

  // Per-pipeline AgentCard.
  app.get("/.well-known/agent-card/:pipelineId", async (req, reply) => {
    const { pipelineId } = req.params as { pipelineId: string };
    try {
      const resolved = await kernel.registry.resolvePipeline(pipelineId);
      reply.header("content-type", "application/json");
      return buildAgentCard(resolved, cardOptions());
    } catch (err) {
      return reply.code(404).send({ error: `pipeline not found: ${pipelineId} (${String(err)})` });
    }
  });

  // JSON-RPC invocation endpoint. Maps an A2A `message/send` request to EXACTLY
  // ONE `run_pipeline` and returns a COMPLETED Task carrying the synthesis. This
  // is synchronous: the JSON-RPC response is the completed task, no streaming.
  app.post("/a2a/:pipelineId", async (req, reply) => {
    const { pipelineId } = req.params as { pipelineId: string };
    const body = (req.body ?? {}) as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: { message?: unknown };
    };
    const rpcId = body.id ?? null;

    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return reply.code(400).send(jsonRpcError(rpcId, -32600, "Invalid JSON-RPC 2.0 request"));
    }
    // Synchronous single-shot only: accept the send methods, reject streaming.
    if (body.method !== "message/send" && body.method !== "SendMessage") {
      return reply
        .code(400)
        .send(
          jsonRpcError(
            rpcId,
            -32601,
            `Unsupported method "${body.method}" (this agent is synchronous: use message/send)`,
          ),
        );
    }

    const message = body.params?.message;
    const input = inputFromMessage(message);
    if (!input) {
      return reply
        .code(400)
        .send(jsonRpcError(rpcId, -32602, "params.message must carry at least one text/data part"));
    }

    // Confirm the pipeline exists before running (clean 404-equivalent error).
    try {
      await kernel.registry.resolvePipeline(pipelineId);
    } catch (err) {
      return reply
        .code(404)
        .send(jsonRpcError(rpcId, -32004, `pipeline not found: ${pipelineId} (${String(err)})`));
    }

    // EXACTLY ONE run_pipeline.
    const run = await kernel.executor.run({ pipelineId, input });
    const task = runResultToTask(run);

    // A2A Send Message Response: { task } (a completed Task). Wrapped in the
    // JSON-RPC envelope as `result`.
    return reply.code(200).send({ jsonrpc: "2.0", id: rpcId, result: { task } });
  });
}
