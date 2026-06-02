// Specs (TypeBox single source of truth)
export * from "./specs/ProviderSpec.js";
export * from "./specs/ChannelSpec.js";
export * from "./specs/PipelineSpec.js";
export * from "./specs/RunRequest.js";
export * from "./specs/RunResult.js";
export * from "./specs/loadPipeline.js";

// Plugin interfaces
export * from "./plugins/ProviderAdapter.js";
export * from "./plugins/PromptRegistry.js";
export * from "./plugins/ResultStore.js";
export * from "./plugins/TelemetrySink.js";
export * from "./plugins/PolicyPlugin.js";
export * from "./plugins/Exporter.js";

// Rendering / validation
export * from "./rendering/PromptRenderer.js";
export * from "./validation/JsonSchemaValidator.js";
export * from "./validation/PipelineValidator.js";

// Policies
export * from "./policies/CostBudgetPolicy.js";

// Executor
export * from "./executor/ExecutionPlan.js";
export * from "./executor/RecursionPolicy.js";
export * from "./executor/ChannelExecutor.js";
export * from "./executor/PipelineExecutor.js";

// Bundle
export * from "./bundle/RunBundle.js";
export * from "./bundle/RunBundleExporter.js";

// Canonical references + bundle signing (Phase 6 / S21)
export * from "./refs/CanonicalRef.js";
export * from "./signing/InstanceKeypair.js";
export * from "./signing/BundleSignature.js";
export * from "./signing/readBundleFiles.js";

// Federation (Phase 6 / S22)
export * from "./federation/TrustConfig.js";
export * from "./federation/ForeignRunStore.js";
export * from "./federation/FederationClient.js";

// External pipeline registry protocol (Phase 6 / S24)
export * from "./federation/ExternalRegistry.js";

// Cross-run reasoning
export * from "./diff/RunDiffer.js";
export * from "./stats/StatsQueries.js";
export * from "./replay/Replayer.js";
export * from "./selection/ModelSelector.js";

// Security (delegated-agent callback signing)
export * from "./security/CallbackSigning.js";
export * from "./security/CallbackSecretStore.js";

// A2A AgentCard exposure (Phase 7 / R5) — validation against the vendored schema.
export * from "./a2a/A2AValidator.js";

// Utils
export * from "./util/hash.js";
