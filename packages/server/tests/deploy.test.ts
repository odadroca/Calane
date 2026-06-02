import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel.js";

/**
 * R4 deploy tests: render.yaml is well-formed for a single-tenant deploy, and
 * the env-driven SQLite store persists runs across a kernel restart (proving the
 * persistent-disk path survives a redeploy). No YAML dependency is added — the
 * blueprint is asserted with targeted string/structure checks.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("render.yaml blueprint (R4)", () => {
  it("declares a web service with health check, persistent disk, and SQLite env", async () => {
    const yaml = await readFile(join(repoRoot, "render.yaml"), "utf8");
    expect(yaml).toMatch(/type:\s*web/);
    expect(yaml).toMatch(/healthCheckPath:\s*\/health/);
    // Combined entrypoint serves both REST and /mcp.
    expect(yaml).toMatch(/combined\.js/);
    // Persistent disk mounted, SQLite path on it.
    expect(yaml).toMatch(/mountPath:\s*\/data/);
    expect(yaml).toMatch(/CALANE_SQLITE_PATH/);
    expect(yaml).toMatch(/\/data\/calane\.sqlite/);
    expect(yaml).toMatch(/CALANE_STORE_DRIVER/);
  });

  it("marks every secret env var as sync:false (none committed)", async () => {
    const yaml = await readFile(join(repoRoot, "render.yaml"), "utf8");
    // Secret keys must appear with `sync: false` and never a literal value.
    for (const secret of ["CALANE_API_TOKEN", "ANTHROPIC_API_KEY", "CALANE_OIDC_ISSUER"]) {
      // The key line is immediately followed (next non-blank line) by sync: false.
      const block = new RegExp(`${secret}[^\\n]*\\n\\s*sync:\\s*false`);
      expect(block.test(yaml)).toBe(true);
    }
    // No obvious committed secret value.
    expect(yaml).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

describe("env-driven SQLite store persists across restart (R4)", () => {
  it("a run stored via one kernel is readable by a fresh kernel at the same path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "calane-deploy-"));
    const sqlitePath = join(dir, "calane.sqlite");
    const prev = process.env.CALANE_SQLITE_PATH;
    process.env.CALANE_SQLITE_PATH = sqlitePath; // documented persistent-disk path
    try {
      // First "deploy": run a pipeline, store it on the SQLite disk path.
      const k1 = createKernel({ storeRoot: dir });
      expect(k1.store.name).toBe("sqlite");
      const run = await k1.executor.run({
        pipelineId: "swot_recursive",
        input: "ACME enters EV market",
        options: { providers: ["mock"], depth: 1 },
      });
      const id = run.runId;

      // Second "deploy": a brand-new kernel pointed at the same disk path.
      const k2 = createKernel({ storeRoot: dir });
      expect(k2.store.name).toBe("sqlite");
      const restored = await k2.store.getRun(id);
      expect(restored?.runId).toBe(id);
      expect(await k2.store.listRuns()).toContain(id);
    } finally {
      if (prev === undefined) process.env.CALANE_SQLITE_PATH = "";
      else process.env.CALANE_SQLITE_PATH = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
