import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * IdP-agnostic OIDC / OAuth 2.1 resource-server token verification (R2).
 *
 * This server is an OAuth **resource server** only: it does NOT implement an
 * authorization server, account system, or any IdP-vendor SDK. It validates
 * incoming access tokens (RS256 JWTs) against a configurable issuer + JWKS, all
 * env-driven, so any standards-compliant IdP (Auth0/Clerk/WorkOS/Keycloak/...)
 * works with no code change and no vendor lock. Verification uses `node:crypto`
 * (JWK import + RS256 verify) — no new dependency.
 *
 * The S11 `CALANE_API_TOKEN` bearer path is unaffected; dual auth is wired in
 * server.ts (a request is authorized if it presents EITHER a valid static
 * token OR a valid OAuth access token).
 */

export interface OidcConfig {
  /** Token `iss` must equal this. Also the base for discovery metadata. */
  issuer: string;
  /** Token `aud` must include this (the resource identifier). */
  audience: string;
  /** Where the IdP publishes its signing keys (JWKS). */
  jwksUri: string;
  /**
   * Authorization-server metadata URL advertised to clients. Defaults to the
   * issuer's `/.well-known/oauth-authorization-server`. Templated from env; we
   * never invent IdP-specific endpoints.
   */
  authorizationServerMetadataUrl?: string;
}

/** Read OIDC config from env. Returns undefined when OAuth is not configured. */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | undefined {
  const issuer = env.CALANE_OIDC_ISSUER;
  const audience = env.CALANE_OIDC_AUDIENCE;
  const jwksUri = env.CALANE_OIDC_JWKS_URI;
  if (!issuer || !audience || !jwksUri) return undefined;
  return {
    issuer,
    audience,
    jwksUri,
    authorizationServerMetadataUrl:
      env.CALANE_OIDC_AS_METADATA_URL ??
      `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  };
}

interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
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

  /** Get a JWK by kid, refreshing the cache if stale or the kid is unknown. */
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

/**
 * Verify a compact RS256 JWT access token against the OIDC config + JWKS.
 * Checks: alg=RS256, signature against the JWKS key by `kid`, `iss`, `aud`,
 * `exp`, and `nbf`. Returns a structured verdict (never throws on bad input).
 */
export class JwtVerifier {
  private readonly jwks: JwksClient;
  constructor(
    private readonly config: OidcConfig,
    options: { jwks?: JwksClient; nowMs?: () => number } = {},
  ) {
    this.jwks = options.jwks ?? new JwksClient(config.jwksUri);
    this.now = options.nowMs ?? (() => Date.now());
  }
  private readonly now: () => number;

  async verify(token: string | null | undefined): Promise<JwtVerdict> {
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

    // Issuer.
    if (claims.iss !== this.config.issuer) return { valid: false, reason: "bad_issuer" };
    // Audience (string or array).
    const aud = claims.aud;
    const audOk =
      aud === this.config.audience || (Array.isArray(aud) && aud.includes(this.config.audience));
    if (!audOk) return { valid: false, reason: "bad_audience" };
    // Expiry / not-before (seconds since epoch).
    const nowSec = Math.floor(this.now() / 1000);
    if (typeof claims.exp === "number" && nowSec >= claims.exp) {
      return { valid: false, reason: "expired" };
    }
    if (typeof claims.nbf === "number" && nowSec < claims.nbf) {
      return { valid: false, reason: "not_yet_valid" };
    }

    return { valid: true, claims };
  }
}

/** Resource-server discovery metadata (`/.well-known/oauth-protected-resource`). */
export function protectedResourceMetadata(config: OidcConfig): Record<string, unknown> {
  return {
    resource: config.audience,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    // Where a client fetches the AS metadata to begin the OAuth 2.1 + PKCE flow.
    authorization_server_metadata: config.authorizationServerMetadataUrl,
  };
}

/**
 * Authorization-server metadata POINTER (`/.well-known/oauth-authorization-server`).
 * The kernel is not an AS; this only points clients at the configured IdP's own
 * metadata document (templated from env). It deliberately advertises no token or
 * authorize endpoints of its own.
 */
export function authorizationServerPointer(config: OidcConfig): Record<string, unknown> {
  return {
    issuer: config.issuer,
    authorization_server_metadata: config.authorizationServerMetadataUrl,
    // PKCE is required end-to-end; the IdP performs the actual code exchange.
    code_challenge_methods_supported: ["S256"],
  };
}
