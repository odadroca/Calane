import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { parseRunRef } from "../refs/CanonicalRef.js";

/**
 * Provenance recorded for a foreign (fetched-from-another-instance) run. Foreign
 * runs are READ-ONLY: this store exposes save + read, but never an update or a
 * mutate path, and the run is never re-exportable from this instance (preserving
 * a single signing source per run, per the S22 decision point).
 *
 * TypeBox is the single source of truth for this shape.
 */
export const ForeignProvenance = Type.Object(
  {
    /** Always true: this run originated on another instance. */
    foreign: Type.Literal(true),
    /** The canonical reference the run was fetched by. */
    canonicalRef: Type.String(),
    /** Allowlisted instance id it was fetched from. */
    sourceInstance: Type.String(),
    /** Base URL it was fetched from. */
    sourceBaseUrl: Type.String(),
    /** Whether the foreign signature verified against the allowlisted key. */
    signatureVerified: Type.Boolean(),
    /** ISO timestamp of the fetch. */
    fetchedAt: Type.String(),
  },
  { $id: "ForeignProvenance", additionalProperties: false },
);
export type ForeignProvenance = Static<typeof ForeignProvenance>;

const PROVENANCE_FILE = "provenance.json";

/**
 * Persists foreign run bundles under <root>/<bundle-hash>/:
 *   provenance.json   (ForeignProvenance — marks the run foreign/read-only)
 *   <bundle files...> (the fetched, verified bundle file map, verbatim)
 *
 * Keying by the canonical bundle hash makes the same run de-duplicate across
 * fetches and ties the local copy to its content-addressed identity.
 */
export class ForeignRunStore {
  readonly name = "foreign-filesystem";
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private dirFor(canonicalRef: string): string {
    const { hash } = parseRunRef(canonicalRef);
    return join(this.root, hash);
  }

  /** Store a fetched bundle file map + provenance. Read-only thereafter. */
  async save(provenance: ForeignProvenance, files: Record<string, string>): Promise<string> {
    const dir = this.dirFor(provenance.canonicalRef);
    await mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const target = join(dir, rel);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    await writeFile(join(dir, PROVENANCE_FILE), JSON.stringify(provenance, null, 2), "utf8");
    return dir;
  }

  /** True when a foreign run with this canonical ref is already stored. */
  async has(canonicalRef: string): Promise<boolean> {
    return (await this.getProvenance(canonicalRef)) !== null;
  }

  /** Read the provenance for a stored foreign run, or null when absent. */
  async getProvenance(canonicalRef: string): Promise<ForeignProvenance | null> {
    try {
      const text = await readFile(join(this.dirFor(canonicalRef), PROVENANCE_FILE), "utf8");
      return JSON.parse(text) as ForeignProvenance;
    } catch {
      return null;
    }
  }

  /** Read the stored bundle file map (excluding provenance) for a foreign run. */
  async getBundleFiles(canonicalRef: string): Promise<Record<string, string> | null> {
    const dir = this.dirFor(canonicalRef);
    const files: Record<string, string> = {};
    const walk = async (cur: string, prefix: string): Promise<void> => {
      const entries = await readdir(cur, { withFileTypes: true });
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(join(cur, entry.name), rel);
        } else if (entry.isFile() && rel !== PROVENANCE_FILE) {
          files[rel] = await readFile(join(cur, entry.name), "utf8");
        }
      }
    };
    try {
      await walk(dir, "");
    } catch {
      return null;
    }
    return Object.keys(files).length > 0 ? files : null;
  }

  /** List the canonical-ref hashes of all stored foreign runs. */
  async list(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }
}
