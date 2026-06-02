import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExternalRegistry,
  ExternalRegistryError,
  PipelineExecutor,
  ProviderRegistry,
  isExternalReference,
  parseExternalReference,
} from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(new URL("../../..", import.meta.url)));
const examplesRoot = join(repoRoot, "examples");
const REF = "registry.example.org/acme/swot@v1.0.0";

let storeDir: string;
let cacheDir: string;
let specText: string;
let base: FilesystemPromptRegistry;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ext-store-"));
  cacheDir = await mkdtemp(join(tmpdir(), "ext-cache-"));
  base = new FilesystemPromptRegistry(examplesRoot);
  // The "external" host serves the swot spec; prompt/schema loads fall back to
  // the base examples registry, so a mock run completes end to end.
  specText = await readFile(
    join(examplesRoot, "pipelines", "swot_recursive.pipeline.yaml"),
    "utf8",
  );
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

let fetchCount = 0;
function servingFetch() {
  fetchCount = 0;
  return async (url: string) => {
    fetchCount++;
    if (url.startsWith("https://registry.example.org/pipelines/acme/swot")) {
      return { ok: true, status: 200, text: async () => specText };
    }
    return { ok: false, status: 404, text: async () => "" };
  };
}

describe("S24 external pipeline reference parsing", () => {
  it("recognizes and parses <host>/<namespace>/<id>@<version>", () => {
    expect(isExternalReference(REF)).toBe(true);
    expect(isExternalReference("swot_recursive")).toBe(false);
    const parsed = parseExternalReference(REF);
    expect(parsed).toMatchObject({
      host: "registry.example.org",
      namespace: "acme",
      id: "swot",
      version: "v1.0.0",
    });
  });
});

describe("S24 external registry resolution (read-only)", () => {
  it("refuses a host not in the trusted-host allowlist", async () => {
    const reg = new ExternalRegistry({
      base,
      trustedHosts: [],
      cacheDir,
      fetchImpl: servingFetch(),
    });
    await expect(reg.resolvePipeline(REF)).rejects.toMatchObject({ code: "untrusted_host" });
  });

  it("resolves a trusted external spec, tags source.registry=external, and runs it", async () => {
    const reg = new ExternalRegistry({
      base,
      trustedHosts: ["registry.example.org"],
      cacheDir,
      fetchImpl: servingFetch(),
    });
    const resolved = await reg.resolvePipeline(REF);
    expect(resolved.registry).toBe("external");
    expect(resolved.ref).toBe(REF);
    expect(resolved.pipelineHash).toMatch(/^sha256:/);

    const store = new FilesystemResultStore(storeDir);
    const providers = new ProviderRegistry().register(new MockProvider());
    const executor = new PipelineExecutor({ registry: reg, providers, store });
    const result = await executor.run({
      pipelineId: REF,
      input: "topic",
      options: { providers: ["mock"], depth: 1 },
    });
    expect(result.status).toBe("completed");
    expect(result.source.registry).toBe("external");
    expect(result.source.ref).toBe(REF);
  });

  it("caches the resolved spec (second resolve does not re-fetch) and verifies the hash", async () => {
    const fetchImpl = servingFetch();
    const reg = new ExternalRegistry({
      base,
      trustedHosts: ["registry.example.org"],
      cacheDir: await mkdtemp(join(tmpdir(), "ext-cache2-")),
      fetchImpl,
    });
    await reg.resolvePipeline(REF);
    expect(fetchCount).toBe(1);
    await reg.resolvePipeline(REF); // served from cache
    expect(fetchCount).toBe(1);
  });

  it("rejects a corrupt cache entry rather than trusting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ext-cache3-"));
    const reg = new ExternalRegistry({
      base,
      trustedHosts: ["registry.example.org"],
      cacheDir: dir,
      fetchImpl: servingFetch(),
    });
    await reg.resolvePipeline(REF);
    // Corrupt the single cache file: tamper with specText but keep the old hash.
    const { readdir, readFile: rf, writeFile } = await import("node:fs/promises");
    const files = await readdir(dir);
    const path = join(dir, files[0] as string);
    const entry = JSON.parse(await rf(path, "utf8"));
    entry.specText = `${entry.specText}\n# tampered`;
    await writeFile(path, JSON.stringify(entry));
    await expect(reg.resolvePipeline(REF)).rejects.toBeInstanceOf(ExternalRegistryError);
  });
});
