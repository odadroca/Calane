import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * IdP-agnostic OIDC / OAuth 2.1 access-token verification for the MCP HTTP
 * transport (R2). Mirrors `packages/server/src/oidc.ts`; kept local so the
 * mcp-server package stays standalone (no cross-package coupling, no new dep).
 *
 * The MCP server is an OAuth resource server only — it validates RS256 JWTs
 * against a configurable issuer + JWKS (env-driven), and implements no
 * authorization server or IdP-vendor SDK. Verification uses `node:crypto`.
 */

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
}

/** Read OIDC config from env. Returns undefined when OAuth is not configured. */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | undefined {
  const issuer = env.CALANE_OIDC_ISSUER;
  const audience = env.CALANE_OIDC_AUDIENCE;
  const jwksUri = env.CALANE_OIDC_JWKS_URI;
  if (!issuer || !audience || !jwksUri) return undefined;
  return { issuer, audience, jwksUri };
}

interface Jwk {
  kty: string;
  kid?: string;
  [k: string]: unknown;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Fetches and caches a JWKS, refreshing on an unknown `kid` (key rotation). */
export class JwksClient {
  private keys: Map<string, Jwk> = new Map();
  private lastFetch = 0;
  private readonly ttlMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly jwksUri: string,
    options: { ttlMs?: number; fetchImpl?: FetchLike } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.fetchImpl = options.fetchImpl ?? ((url) => fetch(url) as unknown as ReturnType<FetchLike>);
  }

  private async refresh(): Promise<void> {
    const res = await this.fetchImpl(this.jwksUri);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${this.jwksUri}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, Jwk>();
    for (const k of body.keys ?? []) {
      if (k.kid) next.set(k.kid, k);
    }
    this.keys = next;
    this.lastFetch = Date.now();
  }

  async getKey(kid: string): Promise<Jwk | undefined> {
    const stale = Date.now() - this.lastFetch > this.ttlMs;
    if (this.keys.size === 0 || stale || !this.keys.has(kid)) {
      await this.refresh();
    }
    return this.keys.get(kid);
  }
}

export interface JwtVerdict {
  valid: boolean;
  reason?: string;
  claims?: Record<string, unknown>;
}

function base64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(base64urlToBuffer(seg).toString("utf8"));
}

/** Verify a compact RS256 JWT access token against the OIDC config + JWKS. */
export class JwtVerifier {
  private readonly jwks: JwksClient;
  private readonly now: () => number;
  constructor(
    private readonly config: OidcConfig,
    options: { jwks?: JwksClient; nowMs?: () => number } = {},
  ) {
    this.jwks = options.jwks ?? new JwksClient(config.jwksUri);
    this.now = options.nowMs ?? (() => Date.now());
  }

  async verifyVerdict(token: string | null | undefined): Promise<JwtVerdict> {
    if (!token) return { valid: false, reason: "missing_token" };
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false, reason: "malformed_jwt" };
    const [headerSeg, payloadSeg, sigSeg] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = decodeSegment(headerSeg);
      claims = decodeSegment(payloadSeg);
    } catch {
      return { valid: false, reason: "malformed_jwt" };
    }

    if (header.alg !== "RS256") return { valid: false, reason: "unsupported_alg" };
    const kid = header.kid;
    if (typeof kid !== "string") return { valid: false, reason: "missing_kid" };

    const jwk = await this.jwks.getKey(kid).catch(() => undefined);
    if (!jwk) return { valid: false, reason: "unknown_key" };

    let ok = false;
    try {
      const key = createPublicKey({ key: jwk as never, format: "jwk" });
      ok = cryptoVerify(
        "RSA-SHA256",
        Buffer.from(`${headerSeg}.${payloadSeg}`),
        key,
        base64urlToBuffer(sigSeg),
      );
    } catch {
      return { valid: false, reason: "verify_error" };
    }
    if (!ok) return { valid: false, reason: "bad_signature" };

    if (claims.iss !== this.config.issuer) return { valid: false, reason: "bad_issuer" };
    const aud = claims.aud;
    const audOk =
      aud === this.config.audience || (Array.isArray(aud) && aud.includes(this.config.audience));
    if (!audOk) return { valid: false, reason: "bad_audience" };
    const nowSec = Math.floor(this.now() / 1000);
    if (typeof claims.exp === "number" && nowSec >= claims.exp) {
      return { valid: false, reason: "expired" };
    }
    if (typeof claims.nbf === "number" && nowSec < claims.nbf) {
      return { valid: false, reason: "not_yet_valid" };
    }
    return { valid: true, claims };
  }

  /** Boolean form for the `AsyncTokenVerifier` interface used by buildMcpServer. */
  async verify(token: string | null | undefined): Promise<boolean> {
    return (await this.verifyVerdict(token)).valid;
  }
}
