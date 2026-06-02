import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel.js";
import { callTool } from "../src/tools.js";

/**
 * Executable companion to docs/scenarios/03-surfaces.md (MCP half): exercise the
 * coarse-grained tools an MCP client calls — run_pipeline, get_run_result,
 * export_run_bundle — against a kernel rooted at the example registry.
 */

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

let kernel: ReturnType<typeof createKernel>;
let storeDir: string;
let bundleDir: string;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "scen-mcp-store-"));
  bundleDir = await mkdtemp(join(tmpdir(), "scen-mcp-bundle-"));
  kernel = createKernel({ registryRoot: examplesRoot, storeRoot: storeDir });
});

afterAll(async () => {
  for (const d of [storeDir, bundleDir]) await rm(d, { recursive: true, force: true });
});

describe("scenario 03 (MCP): run_pipeline -> get_run_result -> export_run_bundle", () => {
  it("runs, fetches, and exports through the MCP tool handlers", async () => {
    const run = (await callTool(kernel, "run_pipeline", {
      pipelineId: "swot_recursive",
      input: "Evaluate releasing the kernel as open source.",
      options: { providers: ["mock"], depth: 1 },
    })) as { runId: string; status: string };
    expect(run.status).toBe("completed");

    const fetched = (await callTool(kernel, "get_run_result", { runId: run.runId })) as {
      runId: string;
    };
    expect(fetched.runId).toBe(run.runId);

    const listed = (await callTool(kernel, "list_runs", {})) as { runs: string[] };
    expect(listed.runs).toContain(run.runId);

    const exported = (await callTool(kernel, "export_run_bundle", {
      runId: run.runId,
      outDir: bundleDir,
    })) as { bundlePath: string };
    expect(exported.bundlePath).toContain(bundleDir);
  });

  it("returns an error for an unknown run id", async () => {
    await expect(callTool(kernel, "get_run_result", { runId: "nope" })).rejects.toThrow();
  });
});
