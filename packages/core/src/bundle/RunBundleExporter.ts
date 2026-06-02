import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExportOptions, ExportResult, ExporterInterface } from "../plugins/Exporter.js";
import type { ResultStoreInterface } from "../plugins/ResultStore.js";
import { CANONICAL_REF_FILE, SIGNATURE_FILE } from "../refs/CanonicalRef.js";
import { signBundle } from "../signing/BundleSignature.js";
import type { ChannelResult, RunResult } from "../specs/RunResult.js";
import { buildManifest, redactSecrets } from "./RunBundle.js";

/**
 * RunBundleExporter — writes a reproducible run bundle directory:
 *   manifest.json, input.md, pipeline.resolved.json, execution_plan.json,
 *   channel_results/, raw_outputs/, validation/, final.md
 * Provider credentials are never written into a bundle.
 */
export class RunBundleExporter implements ExporterInterface {
  readonly name = "filesystem-bundle";
  constructor(
    private readonly store: ResultStoreInterface,
    private readonly resolvedPipeline?: unknown,
  ) {}

  async export(result: RunResult, options: ExportOptions): Promise<ExportResult> {
    const bundlePath = join(options.outDir, result.runId);
    const files: string[] = [];
    const contents: Record<string, string> = {};
    const redact = options.redacted ?? false;

    await mkdir(join(bundlePath, "channel_results"), { recursive: true });
    await mkdir(join(bundlePath, "raw_outputs"), { recursive: true });
    await mkdir(join(bundlePath, "validation"), { recursive: true });

    const write = async (rel: string, content: string) => {
      await writeFile(join(bundlePath, rel), content, "utf8");
      files.push(rel);
      contents[rel] = content;
    };

    await write("manifest.json", JSON.stringify(buildManifest(result), null, 2));
    await write("input.md", result.input);
    await write(
      "pipeline.resolved.json",
      JSON.stringify(this.resolvedPipeline ?? { note: "resolved pipeline not supplied" }, null, 2),
    );
    await write(
      "execution_plan.json",
      JSON.stringify(
        {
          pipelineId: result.pipelineId,
          providers: result.providers,
          recursion: result.recursion,
          channels: result.channels.map((c) => c.channelId),
          synthesis: result.synthesis?.channelId ?? null,
        },
        null,
        2,
      ),
    );

    // Enforcement-policy decisions recorded at the before/after-channel hooks.
    await write("policy_decisions.json", JSON.stringify(result.policy ?? [], null, 2));

    const allChannels: ChannelResult[] = [...result.channels];
    if (result.synthesis) allChannels.push(result.synthesis);

    for (const c of allChannels) {
      const key = `${c.channelId}.${shortProvider(c.provider)}`;
      await write(join("channel_results", `${key}.json`), JSON.stringify(c, null, 2));
      await write(
        join("validation", `${c.channelId}.validation.json`),
        JSON.stringify(
          { status: c.status, schemaValid: c.schemaValid, errors: c.validationErrors },
          null,
          2,
        ),
      );
      let raw = "";
      if (c.rawOutputRef) {
        raw = (await this.store.getRawOutput(result.runId, c.rawOutputRef)) ?? "";
      }
      if (redact) raw = redactSecrets(raw);
      await write(join("raw_outputs", `${key}.txt`), raw);
    }

    await write("final.md", renderFinal(result));

    // Optional detached Ed25519 signature. When a keypair is supplied, sign the
    // canonical bundle hash and write signature.json + canonical_ref.txt. The
    // private key never enters the bundle — only the public key and signature.
    let canonicalRef: string | undefined;
    if (options.keypair) {
      const sig = signBundle(contents, options.keypair);
      canonicalRef = sig.canonicalRef;
      await writeFile(join(bundlePath, SIGNATURE_FILE), JSON.stringify(sig, null, 2), "utf8");
      files.push(SIGNATURE_FILE);
      await writeFile(join(bundlePath, CANONICAL_REF_FILE), `${sig.canonicalRef}\n`, "utf8");
      files.push(CANONICAL_REF_FILE);
    }

    return { bundlePath, files, canonicalRef };
  }
}

function shortProvider(provider: string): string {
  return provider.replace(/[^a-z0-9]+/gi, "").toLowerCase() || "provider";
}

function renderFinal(result: RunResult): string {
  const lines: string[] = [
    `# Run ${result.runId}`,
    "",
    `- Pipeline: ${result.pipelineId}`,
    `- Status: ${result.status}`,
    `- Started: ${result.startedAt}`,
    `- Completed: ${result.completedAt ?? "n/a"}`,
    `- Recursion depth: ${result.recursion.currentDepth}/${result.recursion.maxDepth}`,
    "",
    "## Synthesis",
    "",
    result.synthesis
      ? `\`\`\`json\n${JSON.stringify(result.synthesis.parsedOutput, null, 2)}\n\`\`\``
      : "_No synthesis channel._",
    "",
    "## Channels",
    "",
  ];
  for (const c of result.channels) {
    lines.push(
      `### ${c.channelId} (${c.status})`,
      "",
      "```json",
      JSON.stringify(c.parsedOutput, null, 2),
      "```",
      "",
    );
  }
  return lines.join("\n");
}
