import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenAuth } from "../src/auth.js";
import { createKernel } from "../src/kernel.js";
import { buildServer } from "../src/server.js";

/**
 * Executable companion to docs/scenarios/03-surfaces.md (REST half): drive a
 * pipeline through the HTTP surface with Fastify's in-process `inject`, no port
 * binding. Auth is explicitly disabled (empty env) so the flow is deterministic.
 */

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

let app: FastifyInstance;
let storeDir: string;
let bundleDir: string;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "scen-rest-store-"));
  bundleDir = await mkdtemp(join(tmpdir(), "scen-rest-bundle-"));
  const kernel = createKernel({ registryRoot: examplesRoot, storeRoot: storeDir });
  const auth = new TokenAuth({ env: {} as NodeJS.ProcessEnv });
  app = buildServer({ kernel, logger: false, auth });
});

afterAll(async () => {
  await app.close();
  for (const d of [storeDir, bundleDir]) await rm(d, { recursive: true, force: true });
});

describe("scenario 03 (REST): run -> get -> export", () => {
  it("POST /runs executes a pipeline and returns 201 with the RunResult", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        pipelineId: "swot_recursive",
        input: "Evaluate releasing the kernel as open source.",
        options: { providers: ["mock"], depth: 1 },
      },
    });
    expect(res.statusCode).toBe(201);
    const run = res.json();
    expect(run.status).toBe("completed");

    // GET /runs/:id returns the stored run; it also appears in GET /runs.
    const got = await app.inject({ method: "GET", url: `/runs/${run.runId}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().runId).toBe(run.runId);
    const list = await app.inject({ method: "GET", url: "/runs" });
    expect(list.json().runs).toContain(run.runId);

    // GET /runs/:id/export returns a bundle.
    const exp = await app.inject({
      method: "GET",
      url: `/runs/${run.runId}/export?outDir=${encodeURIComponent(bundleDir)}`,
    });
    expect(exp.statusCode).toBe(200);
    expect(exp.json().bundlePath).toContain(bundleDir);
  });

  it("POST /runs 400s when required fields are missing", async () => {
    const res = await app.inject({ method: "POST", url: "/runs", payload: { input: "x" } });
    expect(res.statusCode).toBe(400);
  });
});
