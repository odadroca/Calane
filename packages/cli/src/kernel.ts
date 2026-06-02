import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CallbackSecretStoreInterface,
  ExternalRegistry,
  FederationClient,
  FilesystemCallbackSecretStore,
  ForeignRunStore,
  InstanceKeypair,
  PipelineExecutor,
  type PromptRegistryInterface,
  ProviderRegistry,
  type ResultStoreInterface,
  RunBundleExporter,
  TrustStore,
  parseTrustConfig,
} from "@llm-pipe/core";
import { AnthropicProvider } from "@llm-pipe/provider-anthropic";
import { MockProvider } from "@llm-pipe/provider-mock";
import {
  DelegatedAgentProvider,
  OpenAICompatibleProvider,
} from "@llm-pipe/provider-openai-compatible";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { GitPromptRegistry, isGitUri } from "@llm-pipe/registry-git";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";

export interface Kernel {
  registry: PromptRegistryInterface;
  store: ResultStoreInterface;
  providers: ProviderRegistry;
  executor: PipelineExecutor;
  exporter: RunBundleExporter;
  secretStore: CallbackSecretStoreInterface;
  /** Per-instance Ed25519 signing keypair (S21). */
  keypair: InstanceKeypair;
  /** Explicit federation trust allowlist (S22). */
  trust: TrustStore;
  /** Local read-only store for foreign (fetched) runs (S22). */
  foreignStore: ForeignRunStore;
  /** Federation client for fetching foreign runs (S22). */
  federation: FederationClient;
}

export interface KernelConfig {
  registryRoot?: string;
  storeRoot?: string;
  /** Pre-constructed result store; overrides the default filesystem store. */
  store?: ResultStoreInterface;
}

/** Load the federation trust allowlist from $CALANE_TRUST_CONFIG (JSON), if set. */
function loadTrustStore(): TrustStore {
  const path = process.env.CALANE_TRUST_CONFIG;
  if (!path) return new TrustStore();
  try {
    return new TrustStore(parseTrustConfig(JSON.parse(readFileSync(path, "utf8"))));
  } catch {
    return new TrustStore();
  }
}

/** Wire the default kernel: filesystem registry + store, all MVP providers. */
export function createKernel(config: KernelConfig = {}): Kernel {
  const registryRoot = config.registryRoot ?? process.env.LLM_PIPE_REGISTRY ?? "examples";
  const storeRoot = config.storeRoot ?? process.env.LLM_PIPE_STORE ?? ".runs";

  // A `git+<url>#<ref>:<rootPath>` registry root resolves pipelines from a Git
  // repo (e.g. GitHub) and records the commit SHA; any other value is a local
  // directory tree.
  const registry: PromptRegistryInterface = isGitUri(registryRoot)
    ? new GitPromptRegistry(registryRoot)
    : new FilesystemPromptRegistry(registryRoot);
  const store = config.store ?? new FilesystemResultStore(storeRoot);
  const secretStore = new FilesystemCallbackSecretStore(join(storeRoot, "callback-secrets"));
  const providers = new ProviderRegistry()
    .register(new MockProvider())
    .register(new OpenAICompatibleProvider())
    .register(new DelegatedAgentProvider())
    .register(new AnthropicProvider());

  const executor = new PipelineExecutor({ registry, providers, store });
  const exporter = new RunBundleExporter(store);
  const keypair = new InstanceKeypair({ dir: process.env.CALANE_KEYS_DIR });
  const trust = loadTrustStore();
  const foreignStore = new ForeignRunStore(join(storeRoot, "foreign"));
  const federation = new FederationClient({
    trust,
    store: foreignStore,
    bearerToken: process.env.CALANE_FEDERATION_TOKEN,
  });

  return {
    registry,
    store,
    providers,
    executor,
    exporter,
    secretStore,
    keypair,
    trust,
    foreignStore,
    federation,
  };
}

/** Trusted hosts for external pipeline-registry resolution (S24). */
export function trustedHosts(): string[] {
  return (process.env.CALANE_TRUSTED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * Build an executor whose registry resolves external pipeline references
 * (`<host>/<namespace>/<id>@<version>`) over HTTPS against the trusted-host
 * allowlist, delegating prompt/schema loading to the base filesystem registry.
 * Read-only resolution only.
 */
export function externalExecutor(kernel: Kernel): {
  executor: PipelineExecutor;
  registry: ExternalRegistry;
} {
  const storeRoot = process.env.LLM_PIPE_STORE ?? ".runs";
  const registry = new ExternalRegistry({
    base: kernel.registry,
    trustedHosts: trustedHosts(),
    cacheDir: join(storeRoot, "external-cache"),
    bearerToken: process.env.CALANE_FEDERATION_TOKEN,
  });
  const executor = new PipelineExecutor({
    registry,
    providers: kernel.providers,
    store: kernel.store,
  });
  return { executor, registry };
}
