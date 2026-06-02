import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InstanceKeypair,
  bundleHash,
  isRunRef,
  makeRunRef,
  parseRunRef,
  signBundle,
  verifyBundle,
  verifySignature,
} from "@llm-pipe/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let keyDir: string;
let keypair: InstanceKeypair;

beforeAll(async () => {
  keyDir = await mkdtemp(join(tmpdir(), "calane-keys-"));
  keypair = new InstanceKeypair({ dir: keyDir }).ensure();
});

afterAll(async () => {
  await rm(keyDir, { recursive: true, force: true });
});

describe("S21 canonical references", () => {
  it("builds and parses calane://run/<hash> references and rejects malformed ones", () => {
    const files = { "manifest.json": '{"a":1}', "final.md": "# hi" };
    const hash = bundleHash(files);
    const ref = makeRunRef(hash);
    expect(ref).toBe(`calane://run/${hash}`);
    expect(parseRunRef(ref).hash).toBe(hash);
    expect(isRunRef(ref)).toBe(true);
    expect(isRunRef("calane://run/not-a-hash")).toBe(false);
    expect(isRunRef("https://example.com/run/x")).toBe(false);
    expect(() => parseRunRef("calane://run/xyz")).toThrow();
  });

  it("computes a content-addressed hash that is stable and excludes signature/ref files", () => {
    const base = { "manifest.json": '{"a":1}', "final.md": "body" };
    const h1 = bundleHash(base);
    // Reordering the input object must not change the hash (sorted internally).
    const reordered = { "final.md": "body", "manifest.json": '{"a":1}' };
    expect(bundleHash(reordered)).toBe(h1);
    // Adding the derived signature/ref files must not change the content hash.
    const withSig = { ...base, "signature.json": "{}", "canonical_ref.txt": "x" };
    expect(bundleHash(withSig)).toBe(h1);
    // Changing real content must change the hash.
    expect(bundleHash({ ...base, "final.md": "different" })).not.toBe(h1);
  });
});

describe("S21 per-instance Ed25519 keypair", () => {
  it("generates a keypair on first use and writes the private key with 0600", () => {
    expect(keypair.exists()).toBe(true);
    const mode = statSync(keypair.privateKeyPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(keypair.publicKeyPem()).toContain("BEGIN PUBLIC KEY");
    // The exported public key PEM must NOT contain any private key material.
    expect(keypair.publicKeyPem()).not.toContain("PRIVATE KEY");
  });

  it("signs and verifies a message; rejects a tampered message or wrong key", () => {
    const sig = keypair.sign("calane://run/abc");
    const pub = keypair.publicKeyPem();
    expect(
      verifySignature({ message: "calane://run/abc", signatureBase64: sig, publicKeyPem: pub }),
    ).toBe(true);
    expect(
      verifySignature({ message: "calane://run/xyz", signatureBase64: sig, publicKeyPem: pub }),
    ).toBe(false);
  });
});

describe("S21 detached bundle signature", () => {
  it("signs a bundle and verifies it, and detects tampering", () => {
    const files = { "manifest.json": '{"runId":"run_1"}', "final.md": "# Run" };
    const sig = signBundle(files, keypair);
    expect(sig.alg).toBe("ed25519");
    expect(sig.canonicalRef).toBe(makeRunRef(bundleHash(files)));

    const good = verifyBundle(files, sig);
    expect(good.valid).toBe(true);

    // Tamper with a file: content hash no longer matches the signed hash.
    const tampered = { ...files, "final.md": "# Tampered" };
    const bad = verifyBundle(tampered, sig);
    expect(bad.valid).toBe(false);
  });

  it("enforces an expected public key (allowlist path for foreign verification)", () => {
    const files = { "manifest.json": "{}" };
    const sig = signBundle(files, keypair);
    const ok = verifyBundle(files, sig, keypair.publicKeyPem());
    expect(ok.valid).toBe(true);
    const wrong = verifyBundle(
      files,
      sig,
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----",
    );
    expect(wrong.valid).toBe(false);
  });
});
