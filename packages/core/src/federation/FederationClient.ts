import { verifyBundle } from "../signing/BundleSignature.js";
import type { ForeignProvenance, ForeignRunStore } from "./ForeignRunStore.js";
import { type TrustStore, normalizeBaseUrl } from "./TrustConfig.js";

/**
 * The wire shape a remote instance returns when serving a bundle by canonical
 * reference: the bundle's file map verbatim (including signature.json). The
 * local client recomputes the content hash and verifies the embedded signature
 * against the allowlisted key — it never trusts the remote's word for validity.
 */
export interface FederatedBundleResponse {
  files: Record<string, string>;
}

export type FetchFn = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface FederationClientOptions {
  trust: TrustStore;
  store: ForeignRunStore;
  /** Injectable fetch (defaults to global fetch). Used to simulate remotes in tests. */
  fetchImpl?: FetchFn;
  /** Bearer token presented to the remote (from S11 auth). */
  bearerToken?: string;
}

export class FederationError extends Error {
  constructor(
    readonly code:
      | "untrusted_instance"
      | "fetch_failed"
      | "no_signature"
      | "signature_invalid"
      | "key_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "FederationError";
  }
}

export interface FetchRunResult {
  canonicalRef: string;
  localPath: string;
  provenance: ForeignProvenance;
  alreadyPresent: boolean;
}

/**
 * Fetches a signed run bundle from another Calane instance over HTTPS, verifies
 * its signature against the explicit trust allowlist, and stores it locally as a
 * READ-ONLY foreign run with provenance. Read-only by construction: only fetch
 * is exposed, never an update/re-export path.
 */
export class FederationClient {
  private readonly trust: TrustStore;
  private readonly store: ForeignRunStore;
  private readonly fetchImpl: FetchFn;
  private readonly bearerToken?: string;

  constructor(options: FederationClientOptions) {
    this.trust = options.trust;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchFn);
    this.bearerToken = options.bearerToken;
  }

  /**
   * Fetch a run by canonical reference from a named/allowlisted remote instance.
   * `instance` may be the allowlisted instance id or its base URL.
   */
  async fetchRun(canonicalRef: string, instance: string): Promise<FetchRunResult> {
    const remote = this.trust.getByInstance(instance) ?? this.trust.getByBaseUrl(instance);
    if (!remote) {
      throw new FederationError("untrusted_instance", `remote not in trust allowlist: ${instance}`);
    }

    const existing = await this.store.getProvenance(canonicalRef);
    if (existing) {
      return {
        canonicalRef,
        localPath: existing.canonicalRef,
        provenance: existing,
        alreadyPresent: true,
      };
    }

    const base = normalizeBaseUrl(remote.baseUrl);
    const url = `${base}/federated/bundles/${encodeURIComponent(canonicalRef)}`;
    const headers: Record<string, string> = {};
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;

    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchImpl(url, { headers });
    } catch (err) {
      throw new FederationError("fetch_failed", `fetch failed: ${String(err)}`);
    }
    if (!res.ok) {
      throw new FederationError("fetch_failed", `remote returned status ${res.status}`);
    }
    const body = (await res.json()) as FederatedBundleResponse;
    const files = body?.files ?? {};

    const sigRaw = files["signature.json"];
    if (sigRaw === undefined) {
      throw new FederationError("no_signature", "remote bundle has no signature.json");
    }

    // Verify the embedded signature AND pin it to the allowlisted key.
    const verdict = verifyBundle(files, safeJson(sigRaw), remote.publicKey);
    if (!verdict.valid) {
      const code = verdict.reason.includes("public key") ? "key_mismatch" : "signature_invalid";
      throw new FederationError(code, `foreign signature rejected: ${verdict.reason}`);
    }
    if (verdict.canonicalRef !== canonicalRef) {
      throw new FederationError(
        "signature_invalid",
        `fetched bundle's canonical ref ${verdict.canonicalRef} != requested ${canonicalRef}`,
      );
    }

    const provenance: ForeignProvenance = {
      foreign: true,
      canonicalRef,
      sourceInstance: remote.instance,
      sourceBaseUrl: base,
      signatureVerified: true,
      fetchedAt: new Date().toISOString(),
    };
    const localPath = await this.store.save(provenance, files);
    return { canonicalRef, localPath, provenance, alreadyPresent: false };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
