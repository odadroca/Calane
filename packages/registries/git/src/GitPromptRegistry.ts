import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PromptRegistryInterface, ResolvedPipeline } from "@llm-pipe/core";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { simpleGit } from "simple-git";
import { type GitUri, parseGitUri } from "./parseGitUri.js";

export interface GitPromptRegistryOptions {
  /** Root cache directory. Default: ~/.calane/git-cache. */
  cacheRoot?: string;
}

/**
 * Git-backed prompt registry. Resolves a pipeline definition from a Git
 * repository at a specified ref (branch, tag, or commit SHA), caching a local
 * clone at `<cacheRoot>/<repo-hash>/` and recording the resolved commit SHA.
 *
 * Construct from a Calane Git URI:
 *   git+https://host/owner/repo.git#<ref>:<rootPath>
 *
 * File resolution (prompts/schemas/pipelines) is delegated to a filesystem
 * registry rooted at the checked-out `<rootPath>`. Fetch is lazy: the repo is
 * cloned on first use, and re-fetched when the requested ref changes or is not
 * yet present locally (cache invalidation on ref change).
 *
 * Read-only: this registry never pushes or writes to the remote.
 */
export class GitPromptRegistry implements PromptRegistryInterface {
  readonly name = "git";
  private readonly uri: GitUri;
  private readonly cacheRoot: string;
  private readonly repoDir: string;
  private fs: FilesystemPromptRegistry | null = null;
  private resolvedSha: string | null = null;
  private prepared: Promise<void> | null = null;

  constructor(gitUri: string, options: GitPromptRegistryOptions = {}) {
    this.uri = parseGitUri(gitUri);
    this.cacheRoot = options.cacheRoot ?? join(homedir(), ".calane", "git-cache");
    const repoHash = createHash("sha256").update(this.uri.repoUrl).digest("hex").slice(0, 16);
    this.repoDir = join(this.cacheRoot, repoHash);
  }

  /** Absolute path to the registry root (rootPath inside the checked-out repo). */
  private registryRoot(): string {
    return resolve(this.repoDir, this.uri.rootPath);
  }

  /** Lazily clone + checkout the requested ref. Memoized per instance. */
  private prepare(): Promise<void> {
    if (!this.prepared) {
      this.prepared = this.doPrepare();
    }
    return this.prepared;
  }

  private async doPrepare(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
    const exists = await pathExists(join(this.repoDir, ".git"));

    if (!exists) {
      await mkdir(this.repoDir, { recursive: true });
      await simpleGit().clone(this.uri.repoUrl, this.repoDir);
    }

    const git = simpleGit(this.repoDir);

    // Lazy fetch + cache invalidation on ref change: if the ref isn't resolvable
    // locally, fetch from origin before checking it out.
    if (!(await this.refResolvable(git, this.uri.ref))) {
      await git.fetch(["--all", "--tags"]);
    }

    await git.checkout(this.uri.ref);
    // For a branch ref, make sure we have the latest commit it points at.
    await git.fetch(["--all", "--tags"]).catch(() => undefined);
    try {
      // Fast-forward a checked-out branch to its remote tip when possible.
      await git.pull();
    } catch {
      // Detached HEAD (tag/SHA) or no upstream — fine; the checkout stands.
    }

    this.resolvedSha = (await git.revparse(["HEAD"])).trim();
    this.fs = new FilesystemPromptRegistry(this.registryRoot());
  }

  private async refResolvable(git: ReturnType<typeof simpleGit>, ref: string): Promise<boolean> {
    if (ref === "HEAD") return true;
    try {
      await git.revparse(["--verify", `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  async listPipelines(): Promise<string[]> {
    await this.prepare();
    return this.fs!.listPipelines();
  }

  async resolvePipeline(pipelineId: string): Promise<ResolvedPipeline> {
    await this.prepare();
    const base = await this.fs!.resolvePipeline(pipelineId);
    return {
      ...base,
      registry: this.name,
      ref: this.uri.ref,
      commitSha: this.resolvedSha,
    };
  }

  async loadPrompt(relativePath: string): Promise<string> {
    await this.prepare();
    return this.fs!.loadPrompt(relativePath);
  }

  async loadSchema(relativePath: string): Promise<unknown> {
    await this.prepare();
    return this.fs!.loadSchema(relativePath);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
