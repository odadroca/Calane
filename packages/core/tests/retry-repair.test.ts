import { describe, expect, it } from "vitest";
import type { PlannedChannel } from "../src/executor/ExecutionPlan.js";
import {
  type ChannelAttempt,
  JsonSchemaValidator,
  PromptRenderer,
  type ProviderAdapterInterface,
  type ProviderRequest,
  type ProviderResponse,
  type ResultStoreInterface,
  type RunResult,
  executeChannel,
} from "../src/index.js";

const SCHEMA = {
  type: "object",
  required: ["a"],
  properties: { a: { type: "number" } },
  additionalProperties: false,
};

class MemStore implements ResultStoreInterface {
  readonly name = "mem";
  private raw = new Map<string, string>();
  async saveRun(_r: RunResult): Promise<void> {}
  async getRun(): Promise<RunResult | null> {
    return null;
  }
  async listRuns(): Promise<string[]> {
    return [];
  }
  async saveRawOutput(runId: string, channelKey: string, raw: string): Promise<string> {
    const ref = `raw/${channelKey}.txt`;
    this.raw.set(`${runId}:${ref}`, raw);
    return ref;
  }
  async getRawOutput(runId: string, ref: string): Promise<string | null> {
    return this.raw.get(`${runId}:${ref}`) ?? null;
  }
}

/** Provider that throws `provider_error` the first `failTimes` calls, then succeeds. */
class FlakyProvider implements ProviderAdapterInterface {
  readonly type = "flaky";
  calls = 0;
  constructor(private readonly failTimes: number) {}
  async execute(): Promise<ProviderResponse> {
    this.calls += 1;
    if (this.calls <= this.failTimes) {
      throw new Error("provider_error 503: upstream unavailable");
    }
    return {
      rawOutput: JSON.stringify({ a: 1 }),
      model: "flaky-1",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  }
}

/** Provider that returns schema-invalid output the first `badTimes` calls, then valid. */
class RepairableProvider implements ProviderAdapterInterface {
  readonly type = "repairable";
  calls = 0;
  prompts: string[] = [];
  constructor(private readonly badTimes: number) {}
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls += 1;
    this.prompts.push(request.prompt);
    const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
    if (this.calls <= this.badTimes) {
      return { rawOutput: JSON.stringify({ a: "not-a-number" }), model: "r-1", usage };
    }
    return { rawOutput: JSON.stringify({ a: 42 }), model: "r-1", usage };
  }
}

function planned(type: string): PlannedChannel {
  return {
    channel: { id: "c1", executionMode: "direct_provider", prompt: "p" },
    provider: { id: type, type },
    isSynthesis: false,
  };
}

const noSleep = async () => {};

describe("retry-on-transient-error (S8)", () => {
  it("retries a provider_error up to N times then succeeds", async () => {
    const adapter = new FlakyProvider(2); // fail twice, succeed on 3rd
    const result = await executeChannel(planned("flaky"), {
      adapter,
      renderer: new PromptRenderer(),
      validator: new JsonSchemaValidator(),
      store: new MemStore(),
      runId: "r1",
      promptTemplate: "do it",
      schema: SCHEMA,
      context: { input: "x" },
      retry: { attempts: 3, backoffMs: 1, on: ["provider_error"] },
      sleep: noSleep,
    });
    expect(adapter.calls).toBe(3);
    expect(result.status).toBe("ok");
    const attempts = result.metadata.attempts as ChannelAttempt[];
    expect(attempts).toHaveLength(3);
    expect(attempts.filter((a) => a.status === "error")).toHaveLength(2);
    expect(attempts[2]?.status).toBe("ok");
    expect(attempts[1]?.kind).toBe("retry");
  });

  it("gives up after exhausting retries and reports error", async () => {
    const adapter = new FlakyProvider(10);
    const result = await executeChannel(planned("flaky"), {
      adapter,
      renderer: new PromptRenderer(),
      validator: new JsonSchemaValidator(),
      store: new MemStore(),
      runId: "r2",
      promptTemplate: "do it",
      schema: SCHEMA,
      context: { input: "x" },
      retry: { attempts: 2, backoffMs: 1, on: ["provider_error"] },
      sleep: noSleep,
    });
    expect(adapter.calls).toBe(3); // initial + 2 retries
    expect(result.status).toBe("error");
    const attempts = result.metadata.attempts as ChannelAttempt[];
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.status === "error")).toBe(true);
  });

  it("uses exponential backoff between retries", async () => {
    const adapter = new FlakyProvider(3);
    const slept: number[] = [];
    await executeChannel(planned("flaky"), {
      adapter,
      renderer: new PromptRenderer(),
      validator: new JsonSchemaValidator(),
      store: new MemStore(),
      runId: "r3",
      promptTemplate: "do it",
      schema: SCHEMA,
      context: { input: "x" },
      retry: { attempts: 3, backoffMs: 100, on: ["provider_error"] },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    // backoff for retry index 1,2,3 = 100, 200, 400
    expect(slept).toEqual([100, 200, 400]);
  });
});

describe("repair-on-schema-failure (S8)", () => {
  it("repairs a schema_error up to M times then succeeds", async () => {
    const adapter = new RepairableProvider(2); // bad twice, valid on 3rd
    const result = await executeChannel(planned("repairable"), {
      adapter,
      renderer: new PromptRenderer(),
      validator: new JsonSchemaValidator(),
      store: new MemStore(),
      runId: "r4",
      promptTemplate: "produce json",
      schema: SCHEMA,
      context: { input: "x" },
      repair: { attempts: 3, on: ["schema_error"] },
      sleep: noSleep,
    });
    expect(adapter.calls).toBe(3);
    expect(result.status).toBe("ok");
    expect(result.repairAttempted).toBe(true);
    const attempts = result.metadata.attempts as ChannelAttempt[];
    expect(attempts).toHaveLength(3);
    expect(attempts[0]?.kind).toBe("initial");
    expect(attempts[1]?.kind).toBe("repair");
    expect(attempts[2]?.status).toBe("ok");
  });

  it("honors a custom repair prompt template", async () => {
    const adapter = new RepairableProvider(1);
    await executeChannel(planned("repairable"), {
      adapter,
      renderer: new PromptRenderer(),
      validator: new JsonSchemaValidator(),
      store: new MemStore(),
      runId: "r5",
      promptTemplate: "produce json",
      schema: SCHEMA,
      context: { input: "x" },
      repair: {
        attempts: 1,
        on: ["schema_error"],
        promptTemplate: "FIXME custom-marker schema={{schema}}",
      },
      sleep: noSleep,
    });
    expect(adapter.prompts).toHaveLength(2);
    expect(adapter.prompts[1]).toContain("custom-marker");
  });

  it("stops repairing when the condition is not in the repair.on list", async () => {
    const adapter = new RepairableProvider(5);
    const result = await executeChannel(planned("repairable"), {
      adapter,
      renderer: new PromptRenderer(),
      validator: new JsonSchemaValidator(),
      store: new MemStore(),
      runId: "r6",
      promptTemplate: "produce json",
      schema: SCHEMA,
      context: { input: "x" },
      repair: { attempts: 3, on: ["invalid_json"] }, // schema_error not listed
      sleep: noSleep,
    });
    // schema_error is not a configured repair condition → no repair attempts
    expect(adapter.calls).toBe(1);
    expect(result.status).toBe("schema_error");
  });
});
