import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineExecutor, ProviderRegistry } from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OtelTelemetrySink } from "../src/OtelTelemetrySink.js";

const examplesRoot = join(fileURLToPath(new URL("../../../..", import.meta.url)), "examples");

let storeDir: string;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "otel-"));
});
afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("OtelTelemetrySink", () => {
  it("produces a run > channel > provider_call span hierarchy via a test collector", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const sink = new OtelTelemetrySink({ provider });

    const store = new FilesystemResultStore(storeDir);
    const registry = new FilesystemPromptRegistry(examplesRoot);
    const providers = new ProviderRegistry().register(new MockProvider());
    const executor = new PipelineExecutor({ registry, providers, store, telemetry: sink });

    const result = await executor.run({
      pipelineId: "swot_recursive",
      input: "Evaluate releasing the kernel as open source.",
      options: { providers: ["mock"], depth: 1 },
    });

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    // traceId surfaces in RunResult.telemetry.traceId
    expect(result.telemetry.traceId).toMatch(/^[0-9a-f]{32}$/);

    // run span present, with the same trace id
    const runSpan = spans.find((s) => s.name === "pipeline.run");
    expect(runSpan).toBeDefined();
    expect(runSpan!.spanContext().traceId).toBe(result.telemetry.traceId);

    // one channel span per channel (4) + 1 synthesis = 5
    const channelSpans = spans.filter((s) => s.name.startsWith("channel."));
    expect(channelSpans.length).toBe(5);

    // provider_call spans nested under channel spans
    const providerSpans = spans.filter((s) => s.name === "provider.call");
    expect(providerSpans.length).toBe(5);
    const channelSpanIds = new Set(channelSpans.map((s) => s.spanContext().spanId));
    for (const ps of providerSpans) {
      expect(channelSpanIds.has(ps.parentSpanContext?.spanId ?? "")).toBe(true);
    }

    // required span attributes present on a channel span
    const strengths = channelSpans.find((s) => s.attributes["channel.id"] === "strengths");
    expect(strengths).toBeDefined();
    for (const key of [
      "pipeline.id",
      "pipeline.hash",
      "channel.id",
      "provider.id",
      "usage.input_tokens",
      "usage.output_tokens",
      "latency_ms",
      "validation.status",
    ]) {
      expect(strengths!.attributes).toHaveProperty(key);
    }

    await sink.shutdown();
  });

  it("never throws on emit/endTrace failures (observational policy)", async () => {
    // A sink with no exporter still creates spans in-process and must not throw.
    const sink = new OtelTelemetrySink();
    const traceId = await sink.startTrace("run_x");
    expect(typeof traceId === "string" || traceId === null).toBe(true);
    await expect(
      sink.emit({ runId: "run_x", type: "channel.end", attributes: {}, timestamp: "t" }),
    ).resolves.toBeUndefined();
    await expect(sink.endTrace("run_x")).resolves.toBeUndefined();
    await sink.shutdown();
  });
});
