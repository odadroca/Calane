import type { InstanceKeypair } from "../signing/InstanceKeypair.js";
import type { RunResult } from "../specs/RunResult.js";

export interface ExportOptions {
  /** Destination directory for the run bundle. */
  outDir: string;
  /** Redact obvious secrets from raw outputs in the exported bundle. */
  redacted?: boolean;
  /**
   * When supplied, write a detached Ed25519 signature (signature.json) and the
   * canonical reference (canonical_ref.txt) into the bundle. The private key
   * never enters the bundle.
   */
  keypair?: InstanceKeypair;
}

export interface ExportResult {
  bundlePath: string;
  files: string[];
  /** The `calane://run/<hash>` reference, present when the bundle was signed. */
  canonicalRef?: string;
}

/**
 * ExporterInterface — an OBSERVATIONAL plugin that writes a reproducible run
 * bundle. Exporter failures should not corrupt the stored run.
 */
export interface ExporterInterface {
  readonly name: string;
  export(result: RunResult, options: ExportOptions): Promise<ExportResult>;
}
