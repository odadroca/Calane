import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InstanceKeypair,
  PipelineExecutor,
  ProviderRegistry,
  RunBundleExporter,
  isRunRef,
  verifyBundleDir,
} from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

let storeDir: string;
let bundleRoot: string;
let keyDir: string;
let store: FilesystemResultStore;
let executor: PipelineExecutor;
let exporter: RunBundleExporter;
let keypair: InstanceKeypair;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "sigbundle-store-"));
  bundleRoot = await mkdtemp(join(tmpdir(), "sigbundle-out-"));
  keyDir = await mkdtemp(join(tmpdir(), "sigbundle-keys-"));
  store = new FilesystemResultStore(storeDir);
  const registry = new FilesystemPromptRegistry(examplesRoot);
  const providers = new ProviderRegistry().register(new MockProvider());
  executor = new PipelineExecutor({ registry, providers, store });
  exporter = new RunBundleExporter(store);
  keypair = new InstanceKeypair({ dir: keyDir }).ensure();
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
  await rm(bundleRoot, { recursive: true, force: true });
  await rm(keyDir, { recursive: true, force: true });
});

async function exportSigned() {
  const run = await executor.run({
    pipelineId: "swot_recursive",
    input: "topic",
    options: { providers: ["mock"], depth: 1 },
  });
  return exporter.export(run, { outDir: bundleRoot, keypair });
}

describe("S21 signed run bundle export + verify-bundle", () => {
  it("exports a bundle with a detached signature and canonical reference", async () => {
    const exported = await exportSigned();
    expect(exported.files).toContain("signature.json");
    expect(exported.files).toContain("canonical_ref.txt");
    expect(exported.canonicalRef).toBeDefined();
    expect(isRunRef(exported.canonicalRef!)).toBe(true);
    // The bundle must NOT contain any private key material.
    const sig = JSON.parse(await readFile(join(exported.bundlePath, "signature.json"), "utf8"));
    expect(sig.publicKey).toContain("PUBLIC KEY");
    expect(JSON.stringify(sig)).not.toContain("PRIVATE KEY");
  });

  it("verify-bundle validates a freshly signed bundle", async () => {
    const exported = await exportSigned();
    const verdict = await verifyBundleDir(exported.bundlePath);
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.canonicalRef).toBe(exported.canonicalRef);
  });

  it("verify-bundle fails when a bundle file is tampered with after signing", async () => {
    const exported = await exportSigned();
    await writeFile(join(exported.bundlePath, "final.md"), "# tampered after signing", "utf8");
    const verdict = await verifyBundleDir(exported.bundlePath);
    expect(verdict.valid).toBe(false);
  });

  it("verify-bundle reports no_signature for an unsigned bundle", async () => {
    const run = await executor.run({
      pipelineId: "swot_recursive",
      input: "topic",
      options: { providers: ["mock"], depth: 1 },
    });
    const exported = await exporter.export(run, { outDir: bundleRoot });
    const verdict = await verifyBundleDir(exported.bundlePath);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toContain("no_signature");
  });
});
