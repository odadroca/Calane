import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { PromptRegistryInterface, ResolvedPipeline } from "../plugins/PromptRegistry.js";
import { parsePipeline } from "../specs/loadPipeline.js";
import { canonicalJson, sha256 } from "../util/hash.js";

/**
 * External pipeline registry protocol (S24) — READ-ONLY resolution of a pipeline
 * spec by canonical name across instances:
 *
 *   <host>/<namespace>/<pipeline-id>@<version>
 *     → GET https://<host>/pipelines/<namespace>/<pipeline-id>?version=<version>
 *
 * This is NOT a marketplace: there is no publication endpoint, no curation, no
 * ratings, no discovery directory. Resolution only. Trust is an explicit
 * trusted-host allowlist; an unlisted host is refused.
 *
 * Resolved specs are cached on disk and re-verified by hash on every read, so a
 * tampered cache entry is rejected rather than silently trusted.
 */

const REF_RE = /^(?<host>[^/\s]+)\/(?<namespace>[^/\s]+)\/(?<id>[^@/\s]+)@(?<version>[^/\s]+)$/;

export interface ExternalReference {
  host: string;
  namespace: string;
  id: string;
  version: string;
  /** The full canonical reference string. */
  raw: string;
}

/** True when a string looks like an external pipeline reference. */
export function isExternalReference(ref: string): boolean {
  return REF_RE.test(ref);
}

/** Parse `<host>/<namespace>/<id>@<version>`. Throws when malformed. */
export function parseExternalReference(ref: string): ExternalReference {
  const m = REF_RE.exec(ref);
  if (!m?.groups) {
    throw new Error(
      `Not an external pipeline reference (<host>/<namespace>/<id>@<version>): ${ref}`,
    );
  }
  const g = m.groups as Record<string, string>;
  return {
    host: g.host as string,
    namespace: g.namespace as string,
    id: g.id as string,
    version: g.version as string,
    raw: ref,
  };
}

export type SpecFetchFn = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export class ExternalRegistryError extends Error {
  constructor(
    readonly code: "untrusted_host" | "fetch_failed" | "invalid_spec" | "cache_corrupt",
    message: string,
  ) {
    super(message);
    this.name = "ExternalRegistryError";
  }
}

export interface ExternalRegistryOptions {
  /** Base registry for prompt/schema loading and local pipeline resolution. */
  base: PromptRegistryInterface;
  /** Explicit allowlist of trusted hosts (exact host match). */
  trustedHosts: string[];
  /** Directory for the resolved-spec cache. */
  cacheDir: string;
  /** Injectable fetch (defaults to global fetch); used to simulate remotes in tests. */
  fetchImpl?: SpecFetchFn;
  /** Bearer token presented to the remote host, if any. */
  bearerToken?: string;
}

interface CacheEntry {
  reference: string;
  specText: string;
  specHash: string;
}

/**
 * A PromptRegistry that resolves external pipeline references over HTTPS while
 * delegating prompt/schema loading and local pipeline resolution to a base
 * registry. `resolvePipeline` returns `registry: "external"` and `ref` set to
 * the full canonical reference, so RunResult.source records the provenance.
 */
export class ExternalRegistry implements PromptRegistryInterface {
  readonly name = "external";
  private readonly base: PromptRegistryInterface;
  private readonly trusted: Set<string>;
  private readonly cacheDir: string;
  private readonly fetchImpl: SpecFetchFn;
  private readonly bearerToken?: string;

  constructor(options: ExternalRegistryOptions) {
    this.base = options.base;
    this.trusted = new Set(options.trustedHosts);
    this.cacheDir = resolvePath(options.cacheDir);
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as SpecFetchFn);
    this.bearerToken = options.bearerToken;
  }

  listPipelines(): Promise<string[]> {
    return this.base.listPipelines();
  }

  loadPrompt(relativePath: string): Promise<string> {
    return this.base.loadPrompt(relativePath);
  }

  loadSchema(relativePath: string): Promise<unknown> {
    return this.base.loadSchema(relativePath);
  }

  async resolvePipeline(pipelineId: string): Promise<ResolvedPipeline> {
    if (!isExternalReference(pipelineId)) {
      return this.base.resolvePipeline(pipelineId);
    }
    const ref = parseExternalReference(pipelineId);
    if (!this.trusted.has(ref.host)) {
      throw new ExternalRegistryError(
        "untrusted_host",
        `host not in trusted-host allowlist: ${ref.host}`,
      );
    }

    const cached = await this.readCache(ref.raw);
    const specText = cached ?? (await this.fetchSpec(ref));
    let spec: ReturnType<typeof parsePipeline>;
    try {
      spec = parsePipeline(specText);
    } catch (err) {
      throw new ExternalRegistryError("invalid_spec", `external spec invalid: ${String(err)}`);
    }
    if (!cached) await this.writeCache(ref.raw, specText);

    return {
      spec,
      registry: "external",
      ref: ref.raw,
      commitSha: null,
      pipelineHash: sha256(canonicalJson(spec)),
    };
  }

  private async fetchSpec(ref: ExternalReference): Promise<string> {
    const url = `https://${ref.host}/pipelines/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.id)}?version=${encodeURIComponent(ref.version)}`;
    const headers: Record<string, string> = {};
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    let res: Awaited<ReturnType<SpecFetchFn>>;
    try {
      res = await this.fetchImpl(url, { headers });
    } catch (err) {
      throw new ExternalRegistryError("fetch_failed", `fetch failed: ${String(err)}`);
    }
    if (!res.ok) {
      throw new ExternalRegistryError("fetch_failed", `remote returned status ${res.status}`);
    }
    return res.text();
  }

  private cachePath(reference: string): string {
    // Key by a hash of the reference so arbitrary chars are filesystem-safe.
    return join(this.cacheDir, `${sha256(reference).replace("sha256:", "")}.json`);
  }

  /** Read a cached spec, verifying its stored hash; returns null on miss. */
  private async readCache(reference: string): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(this.cachePath(reference), "utf8");
    } catch {
      return null;
    }
    let entry: CacheEntry;
    try {
      entry = JSON.parse(text) as CacheEntry;
    } catch {
      throw new ExternalRegistryError("cache_corrupt", "external spec cache entry is not JSON");
    }
    if (entry.reference !== reference || sha256(entry.specText) !== entry.specHash) {
      throw new ExternalRegistryError(
        "cache_corrupt",
        `cache hash verification failed for ${reference}`,
      );
    }
    return entry.specText;
  }

  private async writeCache(reference: string, specText: string): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const entry: CacheEntry = { reference, specText, specHash: sha256(specText) };
    await writeFile(this.cachePath(reference), JSON.stringify(entry, null, 2), "utf8");
  }
}
