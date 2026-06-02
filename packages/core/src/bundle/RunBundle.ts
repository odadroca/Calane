import type { RunResult } from "../specs/RunResult.js";

export interface RunBundleManifest {
  runId: string;
  pipelineId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  source: RunResult["source"];
  providers: string[];
  recursion: RunResult["recursion"];
  validation: RunResult["validation"];
  telemetry: RunResult["telemetry"];
  channels: { channelId: string; status: string; schemaValid: boolean; provider: string }[];
}

export function buildManifest(result: RunResult): RunBundleManifest {
  const channels = [...result.channels];
  if (result.synthesis) channels.push(result.synthesis);
  return {
    runId: result.runId,
    pipelineId: result.pipelineId,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    source: result.source,
    providers: result.providers,
    recursion: result.recursion,
    validation: result.validation,
    telemetry: result.telemetry,
    channels: channels.map((c) => ({
      channelId: c.channelId,
      status: c.status,
      schemaValid: c.schemaValid,
      provider: c.provider,
    })),
  };
}

/** Redact obvious secret-looking tokens from text for redacted exports. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]")
    .replace(/\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_JWT]")
    .replace(
      /("?(?:api[_-]?key|authorization|bearer|token|secret)"?\s*[:=]\s*")[^"]+(")/gi,
      "$1[REDACTED]$2",
    );
}
