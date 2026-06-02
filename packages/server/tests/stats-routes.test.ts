import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenAuth } from "../src/auth.js";
import { createKernel } from "../src/kernel.js";
import { buildServer } from "../src/server.js";

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

// Auth disabled (no tokens configured) so we exercise the stats routes directly.
const noAuth = new TokenAuth({ env: {} as NodeJS.ProcessEnv, configPath: "/nonexistent.toml" });

let storeDir: string;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "stats-"));
});
afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("GET /stats/* gating on store type", () => {
  it("refuses with 409 stats_requires_sqlite on the default filesystem store", async () => {
    const kernel = createKernel({ registryRoot: examplesRoot, storeRoot: storeDir });
    const app = buildServer({ logger: false, auth: noAuth, kernel });
    try {
      for (const path of ["/stats/cost", "/stats/latency", "/stats/failures"]) {
        const res = await app.inject({ method: "GET", url: path });
        expect(res.statusCode).toBe(409);
        const body = res.json();
        expect(body.code).toBe("stats_requires_sqlite");
        expect(body.storeName).toBe("filesystem");
      }
    } finally {
      await app.close();
    }
  });

  it("accepts query params on the cost endpoint (still gated)", async () => {
    const kernel = createKernel({ registryRoot: examplesRoot, storeRoot: storeDir });
    const app = buildServer({ logger: false, auth: noAuth, kernel });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/stats/cost?pipeline=swot&range=7d",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("stats_requires_sqlite");
    } finally {
      await app.close();
    }
  });
});
