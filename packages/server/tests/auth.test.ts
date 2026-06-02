import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TokenAuth, bearerFromHeader, loadValidTokens, parseAuthToml } from "../src/auth.js";
import { buildServer } from "../src/server.js";

describe("parseAuthToml", () => {
  it("parses a tokens array, single token, and ignores comments", () => {
    const toml = `# auth config\ntokens = [\n  "tok-a", # first\n  "tok-b"\n]\ntoken = "tok-c"\n`;
    expect(parseAuthToml(toml).sort()).toEqual(["tok-a", "tok-b", "tok-c"]);
  });
  it("returns no tokens for an empty/commented file", () => {
    expect(parseAuthToml("# nothing here\n")).toEqual([]);
  });
});

describe("loadValidTokens", () => {
  it("unions env token and config-file tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auth-"));
    const path = join(dir, "auth.toml");
    await writeFile(path, 'tokens = ["file-token"]\n');
    try {
      const tokens = loadValidTokens({
        env: { CALANE_API_TOKEN: "env-token" } as NodeJS.ProcessEnv,
        configPath: path,
      });
      expect([...tokens].sort()).toEqual(["env-token", "file-token"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("supports multiple tokens from the config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auth-"));
    const path = join(dir, "auth.toml");
    await writeFile(path, 'tokens = ["t1", "t2", "t3"]\n');
    try {
      const tokens = loadValidTokens({ env: {} as NodeJS.ProcessEnv, configPath: path });
      expect([...tokens].sort()).toEqual(["t1", "t2", "t3"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("is disabled (empty) when neither env nor config provide a token", () => {
    const tokens = loadValidTokens({
      env: {} as NodeJS.ProcessEnv,
      configPath: join(tmpdir(), "does-not-exist-xyz.toml"),
    });
    expect(tokens.size).toBe(0);
  });
});

describe("bearerFromHeader", () => {
  it("extracts the token", () => {
    expect(bearerFromHeader("Bearer abc123")).toBe("abc123");
    expect(bearerFromHeader("bearer abc123")).toBe("abc123");
  });
  it("returns null for non-bearer / missing", () => {
    expect(bearerFromHeader(undefined)).toBeNull();
    expect(bearerFromHeader("Basic xyz")).toBeNull();
  });
});

function authedServer() {
  const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret-token" } as NodeJS.ProcessEnv });
  return buildServer({ logger: false, auth });
}

describe("REST bearer auth (S11)", () => {
  it("allows GET /health without a token", async () => {
    const app = authedServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a protected endpoint with no token (401)", async () => {
    const app = authedServer();
    const res = await app.inject({ method: "GET", url: "/runs" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a protected endpoint with an invalid token (401)", async () => {
    const app = authedServer();
    const res = await app.inject({
      method: "GET",
      url: "/runs",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts a protected endpoint with a valid token", async () => {
    const app = authedServer();
    const res = await app.inject({
      method: "GET",
      url: "/runs",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("leaves the surface open when no token is configured", async () => {
    const auth = new TokenAuth({ env: {} as NodeJS.ProcessEnv, configPath: "/nope.toml" });
    const app = buildServer({ logger: false, auth });
    const res = await app.inject({ method: "GET", url: "/runs" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
