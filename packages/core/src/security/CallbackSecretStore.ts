import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Stores per-channel delegated-agent signing secrets ALONGSIDE the run but
 * outside the run bundle. The RunBundleExporter only reads `run.json` and raw
 * outputs, so secrets kept here never appear in an exported bundle.
 *
 * Implementations are keyed by (runId, channelId).
 */
export interface CallbackSecretStoreInterface {
  put(runId: string, channelId: string, secret: string): Promise<void>;
  get(runId: string, channelId: string): Promise<string | null>;
  /** Mark a callback nonce as consumed; returns true if it was already seen. */
  markNonceSeen(key: string): Promise<boolean>;
}

/** In-memory secret store (single instance / tests). */
export class InMemoryCallbackSecretStore implements CallbackSecretStoreInterface {
  private readonly secrets = new Map<string, string>();
  private readonly nonces = new Set<string>();

  async put(runId: string, channelId: string, secret: string): Promise<void> {
    this.secrets.set(`${runId}:${channelId}`, secret);
  }
  async get(runId: string, channelId: string): Promise<string | null> {
    return this.secrets.get(`${runId}:${channelId}`) ?? null;
  }
  async markNonceSeen(key: string): Promise<boolean> {
    if (this.nonces.has(key)) return true;
    this.nonces.add(key);
    return false;
  }
}

/**
 * Filesystem secret store. Writes secrets under
 * `<root>/<runId>/callback-secrets.json` — deliberately NOT under the run's
 * exported bundle layout, and never referenced by the exporter.
 */
export class FilesystemCallbackSecretStore implements CallbackSecretStoreInterface {
  private readonly root: string;
  private readonly seenNonces = new Set<string>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  private file(runId: string): string {
    return join(this.root, runId, "callback-secrets.json");
  }

  private async readAll(runId: string): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file(runId), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async put(runId: string, channelId: string, secret: string): Promise<void> {
    const dir = join(this.root, runId);
    await mkdir(dir, { recursive: true });
    const all = await this.readAll(runId);
    all[channelId] = secret;
    await writeFile(this.file(runId), JSON.stringify(all, null, 2), "utf8");
  }

  async get(runId: string, channelId: string): Promise<string | null> {
    const all = await this.readAll(runId);
    return all[channelId] ?? null;
  }

  async markNonceSeen(key: string): Promise<boolean> {
    if (this.seenNonces.has(key)) return true;
    this.seenNonces.add(key);
    return false;
  }
}
