import { type KeyObject, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenAuth } from "../src/auth.js";
import { JwksClient, JwtVerifier, type OidcConfig, oidcConfigFromEnv } from "../src/oidc.js";
import { buildServer } from "../src/server.js";

/**
 * R2 tests: the server is an IdP-agnostic OAuth resource server. We mint our own
 * RSA keypair, sign RS256 JWTs, and serve a mock JWKS via an injected fetch — no
 * live IdP and no network. Verification is `node:crypto` only (no new dep).
 */

const ISSUER = "https://idp.example.test/";
const AUDIENCE = "calane-resource";
const KID = "test-key-1";

function makeKeys(): { privateKey: KeyObject; jwks: { keys: unknown[] } } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function signJwt(
  privateKey: KeyObject,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" },
): string {
  const head = b64url(header);
  const payload = b64url(claims);
  const sig = cryptoSign("RSA-SHA256", Buffer.from(`${head}.${payload}`), privateKey).toString(
    "base64url",
  );
  return `${head}.${payload}.${sig}`;
}

function mockFetch(jwks: { keys: unknown[] }) {
  return async (_url: string) => ({ ok: true, json: async () => jwks });
}

const config: OidcConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: "https://idp.example.test/.well-known/jwks.json",
};

function verifier(privateKeyJwks: { keys: unknown[] }, nowMs?: () => number): JwtVerifier {
  return new JwtVerifier(config, {
    jwks: new JwksClient(config.jwksUri, { fetchImpl: mockFetch(privateKeyJwks) }),
    nowMs,
  });
}

describe("oidcConfigFromEnv", () => {
  it("returns undefined unless issuer+audience+jwksUri are all set", () => {
    expect(oidcConfigFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    const cfg = oidcConfigFromEnv({
      CALANE_OIDC_ISSUER: ISSUER,
      CALANE_OIDC_AUDIENCE: AUDIENCE,
      CALANE_OIDC_JWKS_URI: config.jwksUri,
    } as NodeJS.ProcessEnv);
    expect(cfg?.issuer).toBe(ISSUER);
    expect(cfg?.authorizationServerMetadataUrl).toContain(
      "/.well-known/oauth-authorization-server",
    );
  });
});

describe("JwtVerifier (RS256, node:crypto)", () => {
  it("accepts a valid token", async () => {
    const { privateKey, jwks } = makeKeys();
    const token = signJwt(privateKey, {
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const v = await verifier(jwks).verify(token);
    expect(v.valid).toBe(true);
  });

  it("rejects a missing token", async () => {
    const { jwks } = makeKeys();
    expect((await verifier(jwks).verify(null)).reason).toBe("missing_token");
  });

  it("rejects a bad signature", async () => {
    const { privateKey, jwks } = makeKeys();
    const other = makeKeys();
    const token = signJwt(other.privateKey, { iss: ISSUER, aud: AUDIENCE });
    void privateKey;
    expect((await verifier(jwks).verify(token)).reason).toBe("bad_signature");
  });

  it("rejects a wrong audience and a wrong issuer", async () => {
    const { privateKey, jwks } = makeKeys();
    const badAud = signJwt(privateKey, { iss: ISSUER, aud: "someone-else" });
    expect((await verifier(jwks).verify(badAud)).reason).toBe("bad_audience");
    const badIss = signJwt(privateKey, { iss: "https://evil.test/", aud: AUDIENCE });
    expect((await verifier(jwks).verify(badIss)).reason).toBe("bad_issuer");
  });

  it("rejects an expired token", async () => {
    const { privateKey, jwks } = makeKeys();
    const token = signJwt(privateKey, {
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    expect((await verifier(jwks).verify(token)).reason).toBe("expired");
  });
});

describe("REST dual auth + discovery (R2)", () => {
  function authedServer(extra: { staticToken?: string } = {}) {
    const { privateKey, jwks } = makeKeys();
    const auth = new TokenAuth({
      env: (extra.staticToken ? { CALANE_API_TOKEN: extra.staticToken } : {}) as NodeJS.ProcessEnv,
      configPath: "/nope.toml",
    });
    const app = buildServer({ logger: false, auth, oidc: config, jwtVerifier: verifier(jwks) });
    return { app, privateKey };
  }

  it("accepts a valid OAuth access token on a protected route", async () => {
    const { app, privateKey } = authedServer();
    const token = signJwt(privateKey, {
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const res = await app.inject({
      method: "GET",
      url: "/runs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a missing/invalid token with 401 + WWW-Authenticate", async () => {
    const { app } = authedServer();
    const res = await app.inject({ method: "GET", url: "/runs" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/resource_metadata/);
    const bad = await app.inject({
      method: "GET",
      url: "/runs",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it("still accepts the static S11 bearer token (dual auth)", async () => {
    const { app } = authedServer({ staticToken: "s11-token" });
    const res = await app.inject({
      method: "GET",
      url: "/runs",
      headers: { authorization: "Bearer s11-token" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("serves protected-resource and authorization-server metadata unauthenticated", async () => {
    const { app } = authedServer();
    const prm = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(prm.statusCode).toBe(200);
    expect(prm.json().authorization_servers).toEqual([ISSUER]);
    const asm = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(asm.statusCode).toBe(200);
    expect(asm.json().code_challenge_methods_supported).toEqual(["S256"]);
    await app.close();
  });
});
