import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CallbackSecretStoreInterface,
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
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { SqliteResultStore } from "@llm-pipe/store-sqlite";

export interface Kernel {
  registry: PromptRegistryInterface;
  store: ResultStoreInterface;
  providers: ProviderRegistry;
  executor: PipelineExecutor;
  exporter: RunBundleExporter;
  /** Per-channel delegated-agent signing secrets (kept out of bundle exports). */
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

/**
 * Select the result store from env (R4). Defaults to the filesystem store so
 * existing behavior and tests are unchanged. For Render's persistent disk, set
 * `CALANE_STORE_DRIVER=sqlite` and `CALANE_SQLITE_PATH=/data/calane.sqlite` (a
 * path on the mounted disk) so runs survive redeploys; SQLite also unlocks the
 * cross-run stats endpoints.
 */
function selectStore(storeRoot: string): ResultStoreInterface {
  const driver = (process.env.CALANE_STORE_DRIVER ?? "").toLowerCase();
  const sqlitePath = process.env.CALANE_SQLITE_PATH;
  if (driver === "sqlite" || sqlitePath) {
    return new SqliteResultStore(sqlitePath ?? join(storeRoot, "calane.sqlite"));
  }
  return new FilesystemResultStore(storeRoot);
}

export function createKernel(config: { registryRoot?: string; storeRoot?: string } = {}): Kernel {
  const registryRoot = config.registryRoot ?? process.env.LLM_PIPE_REGISTRY ?? "examples";
  const storeRoot = config.storeRoot ?? process.env.LLM_PIPE_STORE ?? ".runs";
  const registry = new FilesystemPromptRegistry(registryRoot);
  const store = selectStore(storeRoot);
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
