import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// These tests guard the runtime entrypoints against the boot regression where
// tsup code-splitting stranded the `isMain` bootstrap in a shared chunk (so
// `node dist/server.js` never listened) and `combined.js` only matched when
// invoked with an absolute path. We spawn the BUILT artifacts via a RELATIVE
// path from the repo root — the exact invocation that used to fail — and assert
// they actually serve traffic without crashing or double-listening.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const SERVER_ENTRY = "packages/server/dist/server.js";
const COMBINED_ENTRY = "packages/server/dist/combined.js";

beforeAll(() => {
  const artifacts = [SERVER_ENTRY, COMBINED_ENTRY].map((p) => resolve(repoRoot, p));
  if (artifacts.some((p) => !existsSync(p))) {
    // Standard flow runs `pnpm build` before `pnpm test`; build defensively if a
    // bare `vitest` run skipped it, so the test always exercises current source.
    execFileSync("pnpm", ["--filter", "@llm-pipe/server", "build"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  }
}, 120_000);

function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => res(port));
      } else {
        srv.close(() => rej(new Error("could not allocate a free port")));
      }
    });
  });
}

const running: ChildProcess[] = [];

afterEach(() => {
  while (running.length > 0) {
    const child = running.pop();
    child?.kill("SIGKILL");
  }
});

/** Spawn a built entrypoint via its RELATIVE path from the repo root. */
function boot(relEntry: string, port: number): { child: ChildProcess; output: () => string } {
  const child = spawn("node", [relEntry], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
  });
  running.push(child);
  let output = "";
  child.stdout?.on("data", (d) => {
    output += String(d);
  });
  child.stderr?.on("data", (d) => {
    output += String(d);
  });
  return { child, output: () => output };
}

async function waitForHealth(port: number, timeoutMs = 10_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/health`);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`entrypoint never became healthy on :${port}: ${String(lastErr)}`);
}

describe("server.js entrypoint", () => {
  it("boots via a relative path and serves REST + static routes", async () => {
    const port = await getFreePort();
    const { child, output } = boot(SERVER_ENTRY, port);

    const health = await waitForHealth(port);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    // Dynamic OpenAPI doc.
    expect((await fetch(`http://127.0.0.1:${port}/openapi.json`)).status).toBe(200);
    // Static manifest served by @fastify/static — exercises the publicDir
    // resolution that depends on the bundle's import.meta.url layout.
    expect((await fetch(`http://127.0.0.1:${port}/openai.json`)).status).toBe(200);

    // Still alive (no crash) and no port conflict from a stray second listen.
    expect(child.exitCode).toBeNull();
    expect(output()).not.toMatch(/EADDRINUSE/);
  }, 20_000);
});

describe("combined.js entrypoint", () => {
  it("boots via a relative path and wires both REST and /mcp", async () => {
    const port = await getFreePort();
    const { child, output } = boot(COMBINED_ENTRY, port);

    const health = await waitForHealth(port);
    expect(health.status).toBe(200);

    // The MCP Streamable HTTP transport is mounted at /mcp. A tools/list without
    // an initialize handshake legitimately returns 400 ("no valid session id"),
    // which proves the transport is wired (vs. 404 / connection refused).
    const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(400);

    // No double-listen: combined.js must NOT also fire server.js's bootstrap.
    expect(child.exitCode).toBeNull();
    expect(output()).not.toMatch(/EADDRINUSE/);
  }, 20_000);
});
