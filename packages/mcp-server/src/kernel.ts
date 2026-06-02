import { join } from "node:path";
import {
  type CallbackSecretStoreInterface,
  FilesystemCallbackSecretStore,
  PipelineExecutor,
  type PromptRegistryInterface,
  ProviderRegistry,
  type ResultStoreInterface,
  RunBundleExporter,
} from "@llm-pipe/core";
import { AnthropicProvider } from "@llm-pipe/provider-anthropic";
import { MockProvider } from "@llm-pipe/provider-mock";
import {
  DelegatedAgentProvider,
  OpenAICompatibleProvider,
} from "@llm-pipe/provider-openai-compatible";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";

export interface Kernel {
  registry: PromptRegistryInterface;
  store: ResultStoreInterface;
  providers: ProviderRegistry;
  executor: PipelineExecutor;
  exporter: RunBundleExporter;
  /** Per-channel delegated-agent signing secrets (kept out of bundle exports). */
  secretStore: CallbackSecretStoreInterface;
}

export function createKernel(config: { registryRoot?: string; storeRoot?: string } = {}): Kernel {
  const registryRoot = config.registryRoot ?? process.env.LLM_PIPE_REGISTRY ?? "examples";
  const storeRoot = config.storeRoot ?? process.env.LLM_PIPE_STORE ?? ".runs";
  const registry = new FilesystemPromptRegistry(registryRoot);
  const store = new FilesystemResultStore(storeRoot);
  const secretStore = new FilesystemCallbackSecretStore(join(storeRoot, "callback-secrets"));
  const providers = new ProviderRegistry()
    .register(new MockProvider())
    .register(new OpenAICompatibleProvider())
    .register(new DelegatedAgentProvider())
    .register(new AnthropicProvider());
  const executor = new PipelineExecutor({ registry, providers, store });
  const exporter = new RunBundleExporter(store);
  return { registry, store, providers, executor, exporter, secretStore };
}
