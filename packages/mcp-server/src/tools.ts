import { PipelineValidator } from "@llm-pipe/core";
import type { Kernel } from "./kernel.js";

/**
 * The compact, mandatory MCP tool surface: exactly 8 coarse-grained tools.
 * This is intentionally NOT one tool per internal class — it sits well below
 * the ~30-tool OpenAI/MCP surface limit. Input schemas are plain JSON Schema
 * (no Zod), per the project's single-source-of-truth schema rule.
 */
export const TOOL_DEFINITIONS = [
  {
    name: "run_pipeline",
    description:
      "Execute a named pipeline against an input and store the run. To resume a " +
      "prior partial run, set options.resumeFromRunId (completed channels are " +
      "carried forward; pipelineId/input are taken from the prior run).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pipelineId", "input"],
      properties: {
        pipelineId: { type: "string" },
        input: { type: "string" },
        options: {
          type: "object",
          additionalProperties: false,
          properties: {
            providers: { type: "array", items: { type: "string" } },
            depth: { type: "number" },
            maxConcurrency: { type: "number" },
            timeoutMs: { type: "number" },
            resumeFromRunId: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "get_run_result",
    description: "Fetch a stored run result by id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: { runId: { type: "string" } },
    },
  },
  {
    name: "list_pipelines",
    description: "List available pipeline ids.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "validate_pipeline",
    description: "Validate a pipeline definition by id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pipelineId"],
      properties: { pipelineId: { type: "string" } },
    },
  },
  {
    name: "export_run_bundle",
    description: "Export a reproducible run bundle for a stored run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string" },
        outDir: { type: "string" },
        redacted: { type: "boolean" },
      },
    },
  },
  {
    name: "rerun_channel",
    description: "Re-run a single channel using an existing run's input.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "channelId"],
      properties: { runId: { type: "string" }, channelId: { type: "string" } },
    },
  },
  {
    name: "list_runs",
    description: "List stored run ids.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "get_pipeline_spec",
    description: "Fetch the resolved spec and source metadata for a pipeline.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pipelineId"],
      properties: { pipelineId: { type: "string" } },
    },
  },
] as const;

export async function callTool(
  kernel: Kernel,
  name: string,
  args: Record<string, any>,
): Promise<unknown> {
  switch (name) {
    case "run_pipeline":
      return kernel.executor.run({
        pipelineId: args.pipelineId,
        input: args.input,
        options: args.options,
      });
    case "get_run_result": {
      const run = await kernel.store.getRun(args.runId);
      if (!run) throw new Error(`run not found: ${args.runId}`);
      return run;
    }
    case "list_pipelines":
      return { pipelines: await kernel.registry.listPipelines() };
    case "validate_pipeline": {
      const resolved = await kernel.registry.resolvePipeline(args.pipelineId);
      const validator = new PipelineValidator({
        loadPrompt: (p) => kernel.registry.loadPrompt(p),
        loadSchema: (p) => kernel.registry.loadSchema(p),
        hasProvider: (t) => kernel.providers.has(t),
      });
      const report = await validator.validate(resolved.spec);
      return { ...report, pipelineHash: resolved.pipelineHash };
    }
    case "export_run_bundle": {
      const run = await kernel.store.getRun(args.runId);
      if (!run) throw new Error(`run not found: ${args.runId}`);
      return kernel.exporter.export(run, {
        outDir: args.outDir ?? "run_bundles",
        redacted: Boolean(args.redacted),
      });
    }
    case "rerun_channel": {
      const prior = await kernel.store.getRun(args.runId);
      if (!prior) throw new Error(`run not found: ${args.runId}`);
      const fresh = await kernel.executor.run({
        pipelineId: prior.pipelineId,
        input: prior.input,
      });
      const channel =
        fresh.channels.find((c) => c.channelId === args.channelId) ??
        (fresh.synthesis?.channelId === args.channelId ? fresh.synthesis : null);
      if (!channel) throw new Error(`channel not found: ${args.channelId}`);
      return { runId: fresh.runId, channel };
    }
    case "list_runs":
      return { runs: await kernel.store.listRuns() };
    case "get_pipeline_spec":
      return kernel.registry.resolvePipeline(args.pipelineId);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
