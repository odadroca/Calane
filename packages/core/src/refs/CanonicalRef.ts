import { sha256 } from "../util/hash.js";

/**
 * Canonical run references — a content-addressed URI scheme that identifies a
 * run bundle by the hash of its canonical content, independent of which
 * instance produced or stores it.
 *
 *   calane://run/<bundle-hash>
 *
 * where <bundle-hash> is the hex sha256 digest (without the "sha256:" prefix)
 * of the bundle's canonical representation (see {@link bundleHash}). The scheme
 * is deliberately minimal: the hash alone identifies the run globally; the
 * remote host to fetch it from is supplied out-of-band (S22), not embedded in
 * the canonical reference.
 */

export const CANONICAL_SCHEME = "calane:";
const RUN_PREFIX = "calane://run/";

/** A 64-char lowercase hex sha256 digest. */
const HEX_HASH = /^[0-9a-f]{64}$/;

export interface ParsedRunRef {
  /** The bare hex hash (no "sha256:" prefix). */
  hash: string;
}

/** Build a canonical run reference from a bare hex hash or a "sha256:"-prefixed hash. */
export function makeRunRef(hash: string): string {
  const bare = stripSha256Prefix(hash);
  if (!HEX_HASH.test(bare)) {
    throw new Error(`Invalid bundle hash for canonical ref: ${hash}`);
  }
  return `${RUN_PREFIX}${bare}`;
}

/** Parse and validate a `calane://run/<hash>` reference. Throws on malformed input. */
export function parseRunRef(ref: string): ParsedRunRef {
  if (!ref.startsWith(RUN_PREFIX)) {
    throw new Error(`Not a canonical run reference (expected ${RUN_PREFIX}…): ${ref}`);
  }
  const hash = ref.slice(RUN_PREFIX.length);
  if (!HEX_HASH.test(hash)) {
    throw new Error(`Malformed bundle hash in canonical ref: ${ref}`);
  }
  return { hash };
}

/** True when the string is a syntactically valid canonical run reference. */
export function isRunRef(ref: string): boolean {
  try {
    parseRunRef(ref);
    return true;
  } catch {
    return false;
  }
}

/** Strip a leading "sha256:" prefix if present, returning the bare hex digest. */
export function stripSha256Prefix(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}

/**
 * Compute the canonical bundle hash from the bundle's file map. Canonicalization
 * rules (so the same logical bundle hashes identically across instances):
 *   - file paths are sorted lexicographically (byte order),
 *   - each file contributes `path\n<sha256-of-bytes>\n` to the digest input,
 *   - the signature file and the canonical-ref file are EXCLUDED (they are
 *     derived from the hash and would otherwise be self-referential),
 *   - the resulting digest is sha256 over the joined manifest text.
 *
 * Returns the bare hex digest (no "sha256:" prefix). Use {@link makeRunRef} to
 * turn it into a `calane://run/<hash>` reference.
 */
export const SIGNATURE_FILE = "signature.json";
export const CANONICAL_REF_FILE = "canonical_ref.txt";

export function bundleHash(files: Record<string, string>): string {
  const lines: string[] = [];
  for (const path of Object.keys(files).sort()) {
    if (path === SIGNATURE_FILE || path === CANONICAL_REF_FILE) continue;
    const contentDigest = sha256(files[path] as string);
    lines.push(`${path}\n${contentDigest}`);
  }
  const manifest = lines.join("\n");
  return stripSha256Prefix(sha256(manifest));
}
