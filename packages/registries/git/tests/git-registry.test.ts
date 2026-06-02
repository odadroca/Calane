import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitPromptRegistry } from "../src/GitPromptRegistry.js";
import { parseGitUri } from "../src/parseGitUri.js";

const exec = promisify(execFile);

let repoDir: string;
let cacheRoot: string;
let mainSha: string;

const pipelineYaml = `id: fixture_pipeline
version: 0.1.0
providers:
  - id: mock
    type: mock
channels:
  - id: analyze
    executionMode: direct_provider
    prompt: prompts/analyze.md
    outputSchema: schemas/out.schema.json
`;

const schemaJson = JSON.stringify({
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
  additionalProperties: false,
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "gitfix-"));
  cacheRoot = await mkdtemp(join(tmpdir(), "gitcache-"));

  await mkdir(join(repoDir, "pipelines"), { recursive: true });
  await mkdir(join(repoDir, "prompts"), { recursive: true });
  await mkdir(join(repoDir, "schemas"), { recursive: true });
  await writeFile(join(repoDir, "pipelines", "fixture.pipeline.yaml"), pipelineYaml, "utf8");
  await writeFile(join(repoDir, "prompts", "analyze.md"), "Analyze {{input}}", "utf8");
  await writeFile(join(repoDir, "schemas", "out.schema.json"), schemaJson, "utf8");

  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["config", "user.email", "test@example.com"]);
  await git(repoDir, ["config", "user.name", "Test"]);
  // Disable commit signing for this throwaway fixture repo (the test env may
  // enforce signing globally, which would break a local-only fixture commit).
  await git(repoDir, ["config", "commit.gpgsign", "false"]);
  await git(repoDir, ["config", "tag.gpgsign", "false"]);
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-q", "-m", "initial pipeline"]);
  await git(repoDir, ["tag", "v1.0.0"]);
  mainSha = await git(repoDir, ["rev-parse", "HEAD"]);
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(cacheRoot, { recursive: true, force: true });
});

describe("parseGitUri", () => {
  it("parses repo, ref, and rootPath", () => {
    const u = parseGitUri("git+https://example.com/o/r.git#v1.0.0:sub/dir");
    expect(u).toEqual({
      repoUrl: "https://example.com/o/r.git",
      ref: "v1.0.0",
      rootPath: "sub/dir",
    });
  });
  it("defaults ref to HEAD and rootPath to '.'", () => {
    expect(parseGitUri("git+https://example.com/o/r.git")).toEqual({
      repoUrl: "https://example.com/o/r.git",
      ref: "HEAD",
      rootPath: ".",
    });
  });
});

describe("GitPromptRegistry", () => {
  it("clones and resolves a pipeline at a branch, populating commitSha and ref", async () => {
    const uri = `git+file://${repoDir}#main:.`;
    const reg = new GitPromptRegistry(uri, { cacheRoot });
    const resolved = await reg.resolvePipeline("fixture_pipeline");
    expect(resolved.registry).toBe("git");
    expect(resolved.ref).toBe("main");
    expect(resolved.commitSha).toBe(mainSha);
    expect(resolved.spec.id).toBe("fixture_pipeline");
  });

  it("resolves a pipeline at a tag ref", async () => {
    const uri = `git+file://${repoDir}#v1.0.0:.`;
    const reg = new GitPromptRegistry(uri, { cacheRoot });
    const resolved = await reg.resolvePipeline("fixture_pipeline");
    expect(resolved.ref).toBe("v1.0.0");
    expect(resolved.commitSha).toBe(mainSha);
  });

  it("resolves a pipeline at an explicit commit SHA", async () => {
    const uri = `git+file://${repoDir}#${mainSha}:.`;
    const reg = new GitPromptRegistry(uri, { cacheRoot });
    const resolved = await reg.resolvePipeline("fixture_pipeline");
    expect(resolved.commitSha).toBe(mainSha);
  });

  it("loads prompt and schema files from the checked-out tree", async () => {
    const uri = `git+file://${repoDir}#main:.`;
    const reg = new GitPromptRegistry(uri, { cacheRoot });
    expect(await reg.loadPrompt("prompts/analyze.md")).toContain("Analyze");
    const schema = (await reg.loadSchema("schemas/out.schema.json")) as { required: string[] };
    expect(schema.required).toContain("summary");
    expect(await reg.listPipelines()).toContain("fixture_pipeline");
  });
});
