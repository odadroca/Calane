import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FederationClient,
  FederationError,
  ForeignRunStore,
  InstanceKeypair,
  PipelineExecutor,
  ProviderRegistry,
  RunBundleExporter,
  TrustStore,
  isRunRef,
  readBundleFiles,
} from "@llm-pipe/core";
import { FilesystemCallbackSecretStore } from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kernel } from "../src/kernel.js";
import { buildServer } from "../src/server.js";

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

let dirA: string;
let dirB: string;
let keysA: string;
let keysOther: string;
let keypairA: InstanceKeypair;
let canonicalRef: string;
let signedFiles: Record<string, string>;

// "Instance A" produces and signs a run bundle. "Instance B" fetches it.
beforeAll(async () => {
  dirA = await mkdtemp(join(tmpdir(), "fedA-"));
  dirB = await mkdtemp(join(tmpdir(), "fedB-"));
  keysA = await mkdtemp(join(tmpdir(), "fedA-keys-"));
  keysOther = await mkdtemp(join(tmpdir(), "fed-other-keys-"));

  const storeA = new FilesystemResultStore(dirA);
  const registry = new FilesystemPromptRegistry(examplesRoot);
  const providers = new ProviderRegistry().register(new MockProvider());
  const executor = new PipelineExecutor({ registry, providers, store: storeA });
  const exporter = new RunBundleExporter(storeA);
  keypairA = new InstanceKeypair({ dir: keysA }).ensure();

  const run = await executor.run({
    pipelineId: "swot_recursive",
    input: "federation topic",
    options: { providers: ["mock"], depth: 1 },
  });
  const out = await mkdtemp(join(tmpdir(), "fedA-bundle-"));
  const exported = await exporter.export(run, { outDir: out, keypair: keypairA });
  canonicalRef = exported.canonicalRef as string;
  signedFiles = await readBundleFiles(exported.bundlePath);
  await rm(out, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
  await rm(keysA, { recursive: true, force: true });
  await rm(keysOther, { recursive: true, force: true });
});

/** Simulated remote A: serves the signed bundle file map for the matching ref. */
function remoteAFetch(expectedToken?: string) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    if (expectedToken && init.headers.authorization !== `Bearer ${expectedToken}`) {
      return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) };
    }
    if (decodeURIComponent(url).includes(canonicalRef)) {
      return { ok: true, status: 200, json: async () => ({ files: signedFiles }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  };
}

describe("S22 federation: fetch a signed run from a trusted remote", () => {
  it("fetches, verifies the foreign signature, and stores it read-only with provenance", async () => {
    const trust = new TrustStore({
      remotes: [
        { instance: "instanceA", baseUrl: "https://a.example", publicKey: keypairA.publicKeyPem() },
      ],
    });
    const foreignStore = new ForeignRunStore(join(dirB, "foreign"));
    const client = new FederationClient({
      trust,
      store: foreignStore,
      fetchImpl: remoteAFetch("tok-fed"),
      bearerToken: "tok-fed",
    });

    expect(isRunRef(canonicalRef)).toBe(true);
    const result = await client.fetchRun(canonicalRef, "instanceA");
    expect(result.alreadyPresent).toBe(false);
    expect(result.provenance.foreign).toBe(true);
    expect(result.provenance.signatureVerified).toBe(true);
    expect(result.provenance.sourceInstance).toBe("instanceA");

    // Stored read-only: provenance + bundle file map are retrievable.
    expect(await foreignStore.has(canonicalRef)).toBe(true);
    const files = await foreignStore.getBundleFiles(canonicalRef);
    expect(files?.["manifest.json"]).toBeDefined();
    expect(files?.["signature.json"]).toBeDefined();

    // A second fetch is idempotent (already present, not re-fetched).
    const again = await client.fetchRun(canonicalRef, "instanceA");
    expect(again.alreadyPresent).toBe(true);
  });

  it("refuses to fetch from an instance not in the trust allowlist", async () => {
    const trust = new TrustStore({ remotes: [] });
    const client = new FederationClient({
      trust,
      store: new ForeignRunStore(join(dirB, "foreign-untrusted")),
      fetchImpl: remoteAFetch(),
    });
    await expect(client.fetchRun(canonicalRef, "instanceA")).rejects.toMatchObject({
      code: "untrusted_instance",
    });
  });

  it("rejects a foreign bundle signed by a non-allowlisted key (key mismatch)", async () => {
    // Trust A by a DIFFERENT key than the one that actually signed the bundle.
    const otherKey = new InstanceKeypair({ dir: keysOther }).ensure().publicKeyPem();
    const trust = new TrustStore({
      remotes: [{ instance: "instanceA", baseUrl: "https://a.example", publicKey: otherKey }],
    });
    const client = new FederationClient({
      trust,
      store: new ForeignRunStore(join(dirB, "foreign-keymismatch")),
      fetchImpl: remoteAFetch(),
    });
    await expect(client.fetchRun(canonicalRef, "instanceA")).rejects.toBeInstanceOf(
      FederationError,
    );
  });

  it("rejects a tampered foreign bundle (signature does not match content)", async () => {
    const trust = new TrustStore({
      remotes: [
        { instance: "instanceA", baseUrl: "https://a.example", publicKey: keypairA.publicKeyPem() },
      ],
    });
    const tampered = { ...signedFiles, "final.md": "# tampered in transit" };
    const client = new FederationClient({
      trust,
      store: new ForeignRunStore(join(dirB, "foreign-tampered")),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ files: tampered }) }),
    });
    await expect(client.fetchRun(canonicalRef, "instanceA")).rejects.toMatchObject({
      code: "signature_invalid",
    });
  });
});

/** Build a minimal Kernel for the REST surface around a given store dir. */
function buildKernel(storeDir: string, keypair: InstanceKeypair, trust: TrustStore): Kernel {
  const store = new FilesystemResultStore(storeDir);
  const registry = new FilesystemPromptRegistry(examplesRoot);
  const providers = new ProviderRegistry().register(new MockProvider());
  const executor = new PipelineExecutor({ registry, providers, store });
  const exporter = new RunBundleExporter(store);
  const secretStore = new FilesystemCallbackSecretStore(join(storeDir, "callback-secrets"));
  const foreignStore = new ForeignRunStore(join(storeDir, "foreign"));
  const federation = new FederationClient({ trust, store: foreignStore });
  return {
    registry,
    store,
    providers,
    executor,
    exporter,
    secretStore,
    keypair,
    trust,
    foreignStore,
    federation,
  };
}

describe("S22 federation REST surface (two in-process instances)", () => {
  it("serves a signed bundle by canonical ref from instance A", async () => {
    const kernelA = buildKernel(dirA, keypairA, new TrustStore());
    const appA = buildServer({ logger: false, kernel: kernelA });
    const res = await appA.inject({
      method: "GET",
      url: `/federated/bundles/${encodeURIComponent(canonicalRef)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: Record<string, string> };
    expect(body.files["signature.json"]).toBeDefined();
    expect(body.files["manifest.json"]).toBeDefined();
    await appA.close();
  });

  it("serves a pipeline spec by namespace/id for external registry resolution (S24)", async () => {
    const kernelA = buildKernel(dirA, keypairA, new TrustStore());
    const appA = buildServer({ logger: false, kernel: kernelA });
    const ok = await appA.inject({ method: "GET", url: "/pipelines/acme/swot_recursive" });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { id: string }).id).toBe("swot_recursive");
    const missing = await appA.inject({ method: "GET", url: "/pipelines/acme/nope" });
    expect(missing.statusCode).toBe(404);
    await appA.close();
  });

  it("B's GET /federated/runs/:ref fetches from A and stores it foreign", async () => {
    const kernelA = buildKernel(dirA, keypairA, new TrustStore());
    const appA = buildServer({ logger: false, kernel: kernelA });

    // Instance B trusts A's public key and routes federation fetches into A.
    const trustB = new TrustStore({
      remotes: [
        { instance: "instanceA", baseUrl: "https://a.example", publicKey: keypairA.publicKeyPem() },
      ],
    });
    const dirBRest = await mkdtemp(join(tmpdir(), "fedB-rest-"));
    const foreignStore = new ForeignRunStore(join(dirBRest, "foreign"));
    const federation = new FederationClient({
      trust: trustB,
      store: foreignStore,
      fetchImpl: async (url, init) => {
        const path = url.replace("https://a.example", "");
        const r = await appA.inject({ method: "GET", url: path, headers: init.headers });
        return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.json() };
      },
    });
    const kernelB: Kernel = {
      ...buildKernel(dirBRest, new InstanceKeypair({ dir: keysOther }), trustB),
      foreignStore,
      federation,
    };
    const appB = buildServer({ logger: false, kernel: kernelB });

    const res = await appB.inject({
      method: "GET",
      url: `/federated/runs/${encodeURIComponent(canonicalRef)}?instance=instanceA`,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { provenance: { foreign: boolean; signatureVerified: boolean } };
    expect(body.provenance.foreign).toBe(true);
    expect(body.provenance.signatureVerified).toBe(true);

    // The foreign run now lists locally on B.
    const list = await appB.inject({ method: "GET", url: "/federated/runs" });
    expect((list.json() as { runs: unknown[] }).runs.length).toBeGreaterThan(0);

    await appA.close();
    await appB.close();
    await rm(dirBRest, { recursive: true, force: true });
  });

  it("B refuses a canonical ref for an instance not in its allowlist (403)", async () => {
    const kernelB = buildKernel(dirB, new InstanceKeypair({ dir: keysOther }), new TrustStore());
    const appB = buildServer({ logger: false, kernel: kernelB });
    const res = await appB.inject({
      method: "GET",
      url: `/federated/runs/${encodeURIComponent(canonicalRef)}?instance=ghost`,
    });
    expect(res.statusCode).toBe(403);
    await appB.close();
  });
});
