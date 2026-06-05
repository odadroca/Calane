import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-instance Ed25519 signing keypair.
 *
 * The PRIVATE key lives on disk at `~/.calane/keys/instance_ed25519` with mode
 * 0600 and is NEVER committed, logged, or written into any exported bundle. Only
 * the PUBLIC key and detached signatures leave this process. The keypair is
 * generated on first use; key loss means previously exported bundles can no
 * longer be re-signed by this instance (existing signatures remain verifiable
 * against the exported public key).
 *
 * Keys are stored as PEM (PKCS#8 for the private key, SPKI for the public key)
 * via `node:crypto` — no new dependency.
 */

const HOME_DEFAULT_DIR = join(homedir(), ".calane", "keys");
const PRIVATE_FILE = "instance_ed25519";
const PUBLIC_FILE = "instance_ed25519.pub";

/**
 * Resolve the key directory at construction time. Precedence:
 *   1. explicit `options.dir` (callers that need to override — tests, ad-hoc).
 *   2. `CALANE_KEYS_DIR` env var (the operational knob that `render.yaml` and
 *      the Dockerfile both set).
 *   3. `~/.calane/keys` (last-resort default for local dev).
 *
 * Evaluating at construction time (not module-load time) means tests can flip
 * the env between cases without re-importing the module. The previous module-
 * level constant meant CLI commands that bypassed `createKernel()` (e.g.
 * `export-run --sign`, `export-key`) silently fell back to `~/.calane/keys`,
 * defeating the Docker / Render `/data/keys` persistence guarantee.
 */
function resolveKeysDir(override?: string): string {
  return override ?? process.env.CALANE_KEYS_DIR ?? HOME_DEFAULT_DIR;
}

export interface KeypairOptions {
  /** Override the key directory. Falls back to `CALANE_KEYS_DIR` then `~/.calane/keys`. */
  dir?: string;
}

export class InstanceKeypair {
  private readonly dir: string;
  private readonly privatePath: string;
  private readonly publicPath: string;

  constructor(options: KeypairOptions = {}) {
    this.dir = resolveKeysDir(options.dir);
    this.privatePath = join(this.dir, PRIVATE_FILE);
    this.publicPath = join(this.dir, PUBLIC_FILE);
  }

  /** True when a private key already exists on disk. */
  exists(): boolean {
    return existsSync(this.privatePath);
  }

  /**
   * Ensure a keypair exists, generating one on first use. The private key file
   * is written with mode 0600. Returns this for chaining.
   */
  ensure(): this {
    if (this.exists()) return this;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    // Write the private key with restrictive permissions from the start.
    writeFileSync(this.privatePath, privPem, { mode: 0o600 });
    chmodSync(this.privatePath, 0o600);
    writeFileSync(this.publicPath, pubPem, { mode: 0o644 });
    return this;
  }

  private loadPrivate(): KeyObject {
    this.ensure();
    return createPrivateKey(readFileSync(this.privatePath, "utf8"));
  }

  /** The instance public key as SPKI PEM text (safe to publish/export). */
  publicKeyPem(): string {
    this.ensure();
    return readFileSync(this.publicPath, "utf8");
  }

  /** Sign a message (utf8 string) with Ed25519, returning a base64 signature. */
  sign(message: string): string {
    const key = this.loadPrivate();
    // Ed25519 takes a null algorithm in node:crypto's one-shot sign().
    return cryptoSign(null, Buffer.from(message, "utf8"), key).toString("base64");
  }

  /** Path of the private key file (for diagnostics; never log its contents). */
  get privateKeyPath(): string {
    return this.privatePath;
  }
}

/**
 * Verify an Ed25519 detached signature (base64) of a utf8 message against a
 * public key supplied as SPKI PEM. Pure function — no disk, no instance key.
 */
export function verifySignature(args: {
  message: string;
  signatureBase64: string;
  publicKeyPem: string;
}): boolean {
  try {
    const key = createPublicKey(args.publicKeyPem);
    return cryptoVerify(
      null,
      Buffer.from(args.message, "utf8"),
      key,
      Buffer.from(args.signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}
