import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ResultStoreInterface, RunResult } from "@llm-pipe/core";

/**
 * Persists runs under <root>/<runId>/:
 *   run.json                  (the RunResult)
 *   raw/<channelKey>.txt      (raw provider outputs; refs stored as "raw/<key>.txt")
 */
export class FilesystemResultStore implements ResultStoreInterface {
  readonly name = "filesystem";
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private runDir(runId: string): string {
    return join(this.root, runId);
  }

  async saveRun(result: RunResult): Promise<void> {
    const dir = this.runDir(result.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), JSON.stringify(result, null, 2), "utf8");
  }

  async getRun(runId: string): Promise<RunResult | null> {
    try {
      const text = await readFile(join(this.runDir(runId), "run.json"), "utf8");
      return JSON.parse(text) as RunResult;
    } catch {
      return null;
    }
  }

  async listRuns(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  async saveRawOutput(runId: string, channelKey: string, raw: string): Promise<string> {
    const dir = join(this.runDir(runId), "raw");
    await mkdir(dir, { recursive: true });
    const safeKey = channelKey.replace(/[^a-z0-9._-]/gi, "_");
    const ref = join("raw", `${safeKey}.txt`);
    await writeFile(join(this.runDir(runId), ref), raw, "utf8");
    return ref;
  }

  async getRawOutput(runId: string, rawOutputRef: string): Promise<string | null> {
    try {
      return await readFile(join(this.runDir(runId), rawOutputRef), "utf8");
    } catch {
      return null;
    }
  }
}
