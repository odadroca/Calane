import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { normalizePem } from "../signing/BundleSignature.js";

/**
 * Federation trust is an EXPLICIT allowlist — there is no open or implicit
 * trust. Each entry pins a remote instance by a stable `instance` id, its base
 * URL (HTTPS), and its Ed25519 public key (SPKI PEM). A fetched bundle is only
 * accepted if its embedded public key matches the allowlisted key for the
 * instance it was fetched from.
 *
 * TypeBox is the single source of truth for this shape.
 */
export const RemoteInstance = Type.Object(
  {
    /** Stable identifier for the remote instance (used in provenance). */
    instance: Type.String(),
    /** Base URL of the remote Calane instance, e.g. https://calane.acme.org. */
    baseUrl: Type.String(),
    /** SPKI PEM Ed25519 public key the remote signs bundles with. */
    publicKey: Type.String(),
  },
  { $id: "RemoteInstance", additionalProperties: false },
);
export type RemoteInstance = Static<typeof RemoteInstance>;

export const TrustConfig = Type.Object(
  {
    remotes: Type.Array(RemoteInstance),
  },
  { $id: "TrustConfig", additionalProperties: false },
);
export type TrustConfig = Static<typeof TrustConfig>;

/** Parse + validate a trust config object (from JSON on disk). Throws on error. */
export function parseTrustConfig(raw: unknown): TrustConfig {
  const errors = [...Value.Errors(TrustConfig, raw)];
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `Invalid trust config: ${first?.path ?? "/"}: ${first?.message ?? "schema error"}`,
    );
  }
  return raw as TrustConfig;
}

/**
 * An immutable, queryable allowlist of trusted remote instances. Lookups are by
 * instance id or by base URL; both reject anything not explicitly listed.
 */
export class TrustStore {
  private readonly byInstance = new Map<string, RemoteInstance>();
  private readonly byBaseUrl = new Map<string, RemoteInstance>();

  constructor(config: TrustConfig = { remotes: [] }) {
    for (const r of config.remotes) {
      this.byInstance.set(r.instance, r);
      this.byBaseUrl.set(normalizeBaseUrl(r.baseUrl), r);
    }
  }

  /** Look up a trusted remote by its instance id, or undefined if not allowlisted. */
  getByInstance(instance: string): RemoteInstance | undefined {
    return this.byInstance.get(instance);
  }

  /** Look up a trusted remote by its base URL, or undefined if not allowlisted. */
  getByBaseUrl(baseUrl: string): RemoteInstance | undefined {
    return this.byBaseUrl.get(normalizeBaseUrl(baseUrl));
  }

  /** True when the given public key matches the allowlisted key for an instance. */
  keyMatches(instance: string, publicKeyPem: string): boolean {
    const r = this.byInstance.get(instance);
    if (!r) return false;
    return normalizePem(r.publicKey) === normalizePem(publicKeyPem);
  }

  list(): RemoteInstance[] {
    return [...this.byInstance.values()];
  }
}

/** Normalize a base URL for comparison: drop a trailing slash, lowercase host. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
