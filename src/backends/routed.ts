import type { AgentBackend } from "./interface.js";
import type { AgentOptions } from "../core/agent-runner.js";
import type { Config } from "../core/types.js";
import type { CreateBackendOptions } from "./factory.js";
import { resolveProfile, resolvePrimaryModelRef } from "../core/profiles.js";

type ConcreteBackendFactory = (
  config: Config,
  agentOptions?: AgentOptions,
  options?: CreateBackendOptions,
) => Promise<AgentBackend>;

function sourceFromSessionKey(sessionKey: string): string {
  return sessionKey.split("--")[0] ?? "";
}

function stripPrefix(text: string, prefix: string): string {
  return text.slice(prefix.length).trimStart();
}

function selectProfileName(
  config: Config,
  message: string,
  sessionKey: string,
): { profile: string; message: string } {
  const source = sourceFromSessionKey(sessionKey);

  for (const binding of config.routing.bindings) {
    if (binding.when.source && binding.when.source !== source) continue;

    if (binding.when.prefix) {
      if (!message.startsWith(binding.when.prefix)) continue;
      return { profile: binding.profile, message: stripPrefix(message, binding.when.prefix) };
    }

    return { profile: binding.profile, message };
  }

  return { profile: config.routing.defaultProfile, message };
}

export async function createRoutedBackend(
  config: Config,
  baseAgentOptions: AgentOptions,
  options: CreateBackendOptions | undefined,
  createConcreteBackend: ConcreteBackendFactory,
): Promise<AgentBackend> {
  const backendCache = new Map<string, AgentBackend>();

  async function getOrCreateBackend(profileName: string): Promise<AgentBackend> {
    const cached = backendCache.get(profileName);
    if (cached) return cached;

    const resolved = resolveProfile(config, profileName);
    if (resolved.backend === "local_llama") {
      throw new Error(`Profile '${profileName}' uses backend 'local_llama' which is not runnable as AgentBackend.`);
    }

    const primaryModel = resolvePrimaryModelRef(resolved.model) ?? config.agent.model ?? undefined;
    const agentOptionsForProfile: AgentOptions = {
      ...baseAgentOptions,
      model: primaryModel ?? undefined,
    };

    const configForProfile: Config = {
      ...config,
      routing: { ...config.routing, enabled: false },
      agent: { ...config.agent, backend: resolved.backend, model: primaryModel ?? null },
    };

    const backend = await createConcreteBackend(configForProfile, agentOptionsForProfile, options);
    backendCache.set(profileName, backend);
    return backend;
  }

  const routed: AgentBackend = {
    name: "routed",
    async *runTurn(message: string, sessionKey: string) {
      const selection = selectProfileName(config, message, sessionKey);
      const backend = await getOrCreateBackend(selection.profile);
      yield* backend.runTurn(selection.message, sessionKey);
    },
    async runTurnSync(message: string, sessionKey: string) {
      const selection = selectProfileName(config, message, sessionKey);
      const backend = await getOrCreateBackend(selection.profile);
      return backend.runTurnSync(selection.message, sessionKey);
    },
    clearSession(sessionKey: string) {
      for (const backend of backendCache.values()) {
        backend.clearSession(sessionKey);
      }
    },
    async close() {
      for (const backend of backendCache.values()) {
        await backend.close?.();
      }
    },
  };

  return routed;
}
