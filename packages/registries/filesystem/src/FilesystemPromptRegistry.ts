import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type PipelineSpec,
  type PromptRegistryInterface,
  type ResolvedPipeline,
  canonicalJson,
  parsePipeline,
  sha256,
} from "@llm-pipe/core";

/**
 * Resolves pipelines/prompts/schemas from a directory tree:
 *   <root>/pipelines/<id>.pipeline.yaml
 *   <root>/prompts/...        (referenced by ChannelSpec.prompt, relative to root)
 *   <root>/schemas/...        (referenced by ChannelSpec.outputSchema, relative to root)
 */
export class FilesystemPromptRegistry implements PromptRegistryInterface {
  readonly name = "filesystem";
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private safeJoin(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new Error(`Registry paths must be relative: ${relativePath}`);
    }
    const full = resolve(this.root, relativePath);
    if (!full.startsWith(this.root)) {
      throw new Error(`Path escapes registry root: ${relativePath}`);
    }
    return full;
  }

  async listPipelines(): Promise<string[]> {
    const dir = join(this.root, "pipelines");
    const entries = await readdir(dir).catch(() => [] as string[]);
    const ids: string[] = [];
    for (const file of entries) {
      if (!file.endsWith(".pipeline.yaml") && !file.endsWith(".pipeline.yml")) continue;
      try {
        const text = await readFile(join(dir, file), "utf8");
        ids.push(parsePipeline(text).id);
      } catch {
        // Skip unparseable files in listing; validate-pipeline surfaces errors.
      }
    }
    return ids;
  }

  async resolvePipeline(pipelineId: string): Promise<ResolvedPipeline> {
    const dir = join(this.root, "pipelines");
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const file of entries) {
      if (!file.endsWith(".pipeline.yaml") && !file.endsWith(".pipeline.yml")) continue;
      const ref = join(dir, file);
      const text = await readFile(ref, "utf8");
      let spec: PipelineSpec;
      try {
        spec = parsePipeline(text);
      } catch {
        continue;
      }
      if (spec.id === pipelineId) {
        return {
          spec,
          registry: this.name,
          ref,
          commitSha: null,
          pipelineHash: sha256(canonicalJson(spec)),
        };
      }
    }
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }

  async loadPrompt(relativePath: string): Promise<string> {
    return readFile(this.safeJoin(relativePath), "utf8");
  }

  async loadSchema(relativePath: string): Promise<unknown> {
    const text = await readFile(this.safeJoin(relativePath), "utf8");
    return JSON.parse(text);
  }
}
