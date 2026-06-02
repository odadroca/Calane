import type { ProviderAdapterInterface } from "../plugins/ProviderAdapter.js";
import type { ResultStoreInterface } from "../plugins/ResultStore.js";
import type { PromptContext, PromptRenderer } from "../rendering/PromptRenderer.js";
import type { CallbackSecretStoreInterface } from "../security/CallbackSecretStore.js";
import { generateChannelSecret } from "../security/CallbackSigning.js";
import type { RepairConfig, RetryConfig } from "../specs/ChannelSpec.js";
import type { ChannelResult, ChannelStatus } from "../specs/RunResult.js";
import type { JsonSchemaValidator } from "../validation/JsonSchemaValidator.js";
import type { PlannedChannel } from "./ExecutionPlan.js";

/** One recorded attempt at running (or repairing) a channel. */
export interface ChannelAttempt {
  /** 1-based attempt index across the whole channel lifecycle. */
  attempt: number;
  kind: "initial" | "retry" | "repair";
  status: ChannelStatus;
  /** Backoff slept before this attempt (ms); 0 for the first / non-retry. */
  backoffMs?: number;
}

const DEFAULT_RETRY_BACKOFF_MS = 200;
const DEFAULT_REPAIR_PROMPT =
  "{{original}}\n\n---\nThe previous response was not valid against the required schema." +
  "\nReturn ONLY a corrected JSON object that conforms to this JSON Schema:\n{{schema}}" +
  "\nPrevious (invalid) output was:\n{{output}}";

export interface ChannelExecutionDeps {
  adapter: ProviderAdapterInterface;
  renderer: PromptRenderer;
  validator: JsonSchemaValidator;
  store: ResultStoreInterface;
  runId: string;
  promptTemplate: string;
  schema: object | null;
  context: PromptContext;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Optional store for per-channel delegated-agent signing secrets. When a
   * channel runs in `delegated_agent` mode and this is provided, a fresh
   * per-channel secret is generated and persisted (alongside the run, never in
   * the bundle) before dispatch so the agent's callback can be HMAC-verified.
   */
  secretStore?: CallbackSecretStoreInterface;
  /**
   * Resolved retry-on-transient-error config for this channel (channel-level
   * overriding pipeline default). When absent, no transient retry is performed.
   */
  retry?: RetryConfig;
  /**
   * Resolved repair-on-schema-failure config for this channel. When absent,
   * falls back to the legacy `channel.repairAttempts` count (default 0).
   */
  repair?: RepairConfig;
  /** Inject a sleep fn (for tests); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes one channel: render -> provider call -> validate -> persist raw.
 * Status mapping covers ok / invalid_json / schema_error / refused / timeout /
 * error. Raw output is always stored, even when validation fails. One repair
 * attempt is made when the channel allows it.
 */
export async function executeChannel(
  planned: PlannedChannel,
  deps: ChannelExecutionDeps,
): Promise<ChannelResult> {
  const { channel } = planned;
  const start = Date.now();
  const channelKey = `${channel.id}.${planned.provider.id}`;

  const base: ChannelResult = {
    channelId: channel.id,
    executionMode: channel.executionMode,
    provider: planned.provider.type,
    model: planned.provider.model ?? null,
    status: "ok",
    latencyMs: 0,
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
    rawOutputRef: null,
    parsedOutput: null,
    schemaValid: false,
    validationErrors: [],
    metadata: { providerId: planned.provider.id, channelKey },
  };

  // Delegated-agent dispatch: mint and persist a per-channel signing secret so
  // the agent's callback (via REST/MCP) can be HMAC-verified against this run.
  if (channel.executionMode === "delegated_agent" && deps.secretStore) {
    try {
      const secret = generateChannelSecret();
      await deps.secretStore.put(deps.runId, channel.id, secret);
      base.metadata = { ...base.metadata, callbackSigning: "hmac-sha256" };
    } catch {
      // Secret persistence failure must not crash the channel; the callback
      // path will simply reject (no secret -> verification fails).
    }
  }

  const prompt = deps.renderer.render(deps.promptTemplate, deps.context);

  // Resolve retry/repair behaviour. Repair falls back to the legacy
  // `repairAttempts` count when no structured repair config is supplied.
  const sleep = deps.sleep ?? defaultSleep;
  const retryAttempts = deps.retry?.attempts ?? 0;
  const retryBackoffMs = deps.retry?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const retryOn = deps.retry?.on ?? ["provider_error", "timeout"];
  const maxRepairs = deps.repair?.attempts ?? channel.repairAttempts ?? 0;
  const repairOn = deps.repair?.on ?? ["schema_error", "invalid_json"];

  const attempts: ChannelAttempt[] = [];
  let attemptCounter = 0;

  // Transient-retry loop: on provider_error / timeout, retry up to N times with
  // exponential backoff. Schema-failure repair happens inside `runWithRepair`.
  let lastError: unknown = null;
  for (let retryIndex = 0; retryIndex <= retryAttempts; retryIndex++) {
    if (retryIndex > 0) {
      const backoffMs = retryBackoffMs * 2 ** (retryIndex - 1);
      await sleep(backoffMs);
    }
    try {
      const outcome = await runWithRepair(prompt, planned, deps, {
        maxRepairs,
        repairOn,
        sleep,
        onAttempt: (kind, status) => {
          attemptCounter += 1;
          attempts.push({
            attempt: attemptCounter,
            kind: retryIndex > 0 && kind === "initial" ? "retry" : kind,
            status,
            backoffMs:
              retryIndex > 0 && kind === "initial" ? retryBackoffMs * 2 ** (retryIndex - 1) : 0,
          });
        },
      });
      const { result, raw } = outcome;
      if (outcome.repairAttempted) base.repairAttempted = true;

      const rawRef = await deps.store.saveRawOutput(deps.runId, channelKey, raw);
      base.latencyMs = Date.now() - start;
      base.usage = result.response.usage;
      base.model = result.response.model ?? base.model;
      base.rawOutputRef = rawRef;
      base.parsedOutput = result.parse.parsed;
      base.validationErrors = result.parse.errors;

      let status: ChannelStatus;
      if (result.response.refused) {
        status = "refused";
        base.schemaValid = false;
      } else if (result.parse.outcome === "valid") {
        status = "ok";
        base.schemaValid = true;
      } else if (result.parse.outcome === "invalid_json") {
        status = "invalid_json";
        base.schemaValid = false;
      } else {
        status = "schema_error";
        base.schemaValid = false;
      }
      base.status = status;
      base.metadata = { ...base.metadata, attempts };
      return base;
    } catch (err) {
      lastError = err;
      const isTimeout = (err as Error)?.name === "AbortError" || /timeout|abort/i.test(String(err));
      const status: ChannelStatus = isTimeout ? "timeout" : "error";
      attemptCounter += 1;
      attempts.push({
        attempt: attemptCounter,
        kind: retryIndex === 0 ? "initial" : "retry",
        status,
        backoffMs: retryIndex > 0 ? retryBackoffMs * 2 ** (retryIndex - 1) : 0,
      });
      // Only retry conditions listed in `retryOn` are retried.
      const condition = isTimeout ? "timeout" : "provider_error";
      if (!retryOn.includes(condition) || retryIndex >= retryAttempts) {
        break;
      }
    }
  }

  // All retries exhausted (or no retry configured) on a transient error.
  base.latencyMs = Date.now() - start;
  const isTimeout =
    (lastError as Error)?.name === "AbortError" || /timeout|abort/i.test(String(lastError));
  base.status = isTimeout ? "timeout" : "error";
  base.validationErrors = [String(lastError)];
  base.metadata = { ...base.metadata, attempts };
  return base;
}

/**
 * Runs the provider call and, on schema/JSON failure, issues up to `maxRepairs`
 * repair prompts. Throws on a transient provider/timeout error so the outer
 * retry loop can handle it.
 */
async function runWithRepair(
  prompt: string,
  planned: PlannedChannel,
  deps: ChannelExecutionDeps,
  opts: {
    maxRepairs: number;
    repairOn: string[];
    sleep: (ms: number) => Promise<void>;
    onAttempt: (kind: "initial" | "repair", status: ChannelStatus) => void;
  },
): Promise<{
  result: Awaited<ReturnType<typeof callAndValidate>>;
  raw: string;
  repairAttempted: boolean;
}> {
  let result = await callAndValidate(prompt, planned, deps);
  let raw = result.response.rawOutput;
  opts.onAttempt("initial", outcomeToStatus(result));

  let repairs = 0;
  let repairAttempted = false;
  while (result.parse.outcome !== "valid" && result.response.refused !== true) {
    const condition = result.parse.outcome === "invalid_json" ? "invalid_json" : "schema_error";
    if (!opts.repairOn.includes(condition) || repairs >= opts.maxRepairs) break;
    repairs += 1;
    repairAttempted = true;
    const repairPrompt = buildRepairPrompt(
      prompt,
      result.response.rawOutput,
      deps.schema,
      deps.repair?.promptTemplate,
    );
    result = await callAndValidate(repairPrompt, planned, deps);
    raw = result.response.rawOutput;
    opts.onAttempt("repair", outcomeToStatus(result));
  }

  return { result, raw, repairAttempted };
}

function outcomeToStatus(result: Awaited<ReturnType<typeof callAndValidate>>): ChannelStatus {
  if (result.response.refused) return "refused";
  if (result.parse.outcome === "valid") return "ok";
  if (result.parse.outcome === "invalid_json") return "invalid_json";
  return "schema_error";
}

async function callAndValidate(
  prompt: string,
  planned: PlannedChannel,
  deps: ChannelExecutionDeps,
) {
  const response = await deps.adapter.execute({
    runId: deps.runId,
    channelId: planned.channel.id,
    prompt,
    outputSchema: deps.schema ?? undefined,
    spec: planned.provider,
    timeoutMs: deps.timeoutMs ?? planned.provider.timeoutMs,
    signal: deps.signal,
  });
  const parse = deps.validator.parseAndValidate(response.rawOutput, deps.schema);
  return { response, parse };
}

function buildRepairPrompt(
  original: string,
  badOutput: string,
  schema: object | null,
  template?: string,
): string {
  const schemaText = schema ? JSON.stringify(schema, null, 2) : "(no schema)";
  const tpl = template ?? DEFAULT_REPAIR_PROMPT;
  return tpl
    .replaceAll("{{original}}", original)
    .replaceAll("{{schema}}", schemaText)
    .replaceAll("{{output}}", badOutput);
}
