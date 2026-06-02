import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CANONICAL_REF_FILE,
  SIGNATURE_FILE,
  bundleHash,
  makeRunRef,
} from "../refs/CanonicalRef.js";
import { type InstanceKeypair, verifySignature } from "./InstanceKeypair.js";

/**
 * Detached bundle signature metadata (the `signature.json` file written into a
 * signed bundle). TypeBox is the single source of truth for this shape. The
 * signed message is the canonical reference `calane://run/<bundle-hash>`, so the
 * signature attests to the bundle's content hash, not to any single file.
 *
 * Only the PUBLIC key and signature appear here; the private key never does.
 */
export const BundleSignature = Type.Object(
  {
    /** Signing algorithm; pinned to Ed25519. */
    alg: Type.Literal("ed25519"),
    /** The canonical run reference that was signed: calane://run/<hash>. */
    canonicalRef: Type.String(),
    /** Bare hex sha256 of the canonical bundle content. */
    bundleHash: Type.String(),
    /** Base64 Ed25519 signature over `canonicalRef`. */
    signature: Type.String(),
    /** SPKI PEM public key of the signing instance. */
    publicKey: Type.String(),
    /** ISO timestamp the signature was produced. */
    signedAt: Type.String(),
  },
  { $id: "BundleSignature", additionalProperties: false },
);
export type BundleSignature = Static<typeof BundleSignature>;

/**
 * Produce a detached signature for a bundle given its file map. The bundle hash
 * is computed over the canonical content (excluding the signature/ref files);
 * the canonical reference is signed with the instance's Ed25519 private key.
 */
export function signBundle(
  files: Record<string, string>,
  keypair: InstanceKeypair,
): BundleSignature {
  const hash = bundleHash(files);
  const canonicalRef = makeRunRef(hash);
  return {
    alg: "ed25519",
    canonicalRef,
    bundleHash: hash,
    signature: keypair.sign(canonicalRef),
    publicKey: keypair.publicKeyPem(),
    signedAt: new Date().toISOString(),
  };
}

export type VerifyVerdict =
  | { valid: true; canonicalRef: string; bundleHash: string }
  | { valid: false; reason: string; canonicalRef?: string };

/**
 * Verify a bundle against a detached signature. Checks, in order:
 *   1. the signature metadata is well-formed,
 *   2. the recomputed content hash matches the signed hash (integrity),
 *   3. the canonical ref matches the recorded hash,
 *   4. the Ed25519 signature over the canonical ref verifies against the key.
 *
 * `expectedPublicKey`, when supplied (S22 foreign verification against a trusted
 * allowlist), must match the embedded public key; otherwise the embedded key is
 * used (self-verification / `verify-bundle`).
 */
export function verifyBundle(
  files: Record<string, string>,
  signatureRaw: unknown,
  expectedPublicKey?: string,
): VerifyVerdict {
  const errors = [...Value.Errors(BundleSignature, signatureRaw)];
  if (errors.length > 0) {
    return { valid: false, reason: `malformed signature: ${errors[0]?.message ?? "schema error"}` };
  }
  const sig = signatureRaw as BundleSignature;

  const recomputed = bundleHash(files);
  if (recomputed !== sig.bundleHash) {
    return {
      valid: false,
      reason: `bundle content hash mismatch (recomputed ${recomputed}, signed ${sig.bundleHash})`,
      canonicalRef: sig.canonicalRef,
    };
  }
  if (sig.canonicalRef !== makeRunRef(sig.bundleHash)) {
    return {
      valid: false,
      reason: "canonical reference does not match signed bundle hash",
      canonicalRef: sig.canonicalRef,
    };
  }
  if (
    expectedPublicKey !== undefined &&
    normalizePem(expectedPublicKey) !== normalizePem(sig.publicKey)
  ) {
    return {
      valid: false,
      reason: "public key does not match the expected (allowlisted) key",
      canonicalRef: sig.canonicalRef,
    };
  }
  const ok = verifySignature({
    message: sig.canonicalRef,
    signatureBase64: sig.signature,
    publicKeyPem: sig.publicKey,
  });
  if (!ok) {
    return {
      valid: false,
      reason: "Ed25519 signature verification failed",
      canonicalRef: sig.canonicalRef,
    };
  }
  return { valid: true, canonicalRef: sig.canonicalRef, bundleHash: sig.bundleHash };
}

/** Normalize PEM text for comparison (line endings + surrounding whitespace). */
export function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, "\n").trim();
}

/**
 * Read a bundle directory's signature.json and verify the bundle. Returns a
 * `no_signature` verdict when the bundle was exported unsigned.
 */
export async function verifyBundleDir(
  bundlePath: string,
  expectedPublicKey?: string,
): Promise<VerifyVerdict> {
  const { readBundleFiles } = await import("./readBundleFiles.js");
  const files = await readBundleFiles(bundlePath);
  const raw = files[SIGNATURE_FILE];
  if (raw === undefined) {
    return { valid: false, reason: "no_signature: bundle has no signature.json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, reason: "malformed signature: signature.json is not valid JSON" };
  }
  return verifyBundle(files, parsed, expectedPublicKey);
}

export { SIGNATURE_FILE, CANONICAL_REF_FILE };
