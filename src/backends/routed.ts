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

function mcpServerForToolName(toolName: string): string | null {
  switch (toolName) {
    case "memory_search":
      return "memory";
    case "cron":
    case "exec":
    case "process":
    case "habits":
    case "drafts":
      return "assistant";
    default:
      return null;
  }
}

function applyToolPolicyToAgentOptions(
  base: AgentOptions,
  tools: Config["profiles"][string]["tools"],
): AgentOptions {
  if (!base.allowedTools) return base;

  const mcpPatternRe = /^mcp__([a-z0-9_-]+)__\*$/i;
  const mcpPatterns: string[] = [];
  const nonMcpTools: string[] = [];
  for (const t of base.allowedTools) {
    if (mcpPatternRe.test(t)) mcpPatterns.push(t);
    else nonMcpTools.push(t);
  }

  const allServers = new Set(
    mcpPatterns
      .map((p) => p.match(mcpPatternRe)?.[1])
      .filter((x): x is string => Boolean(x)),
  );

  let servers = new Set(allServers);

  if (tools.allow.length > 0) {
    servers = new Set(
      tools.allow
        .map((name) => mcpServerForToolName(name))
        .filter((x): x is string => Boolean(x)),
    );
  }

  for (const deny of tools.deny) {
    const server = mcpServerForToolName(deny);
    if (server) servers.delete(server);
  }

  const allowedMcpPatterns = Array.from(servers).map((s) => `mcp__${s}__*`);

  return {
    ...base,
    allowedTools: [...nonMcpTools, ...allowedMcpPatterns],
  };
}

function sourceFromSessionKey(sessionKey: string): string {
  return sessionKey.split("--")[0] ?? "";
}

function stripPrefix(text: string, prefix: string): string {
  return text.slice(prefix.length).trimStart();
}

function looksLikeCodingRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("```")) return true;
  if (t.includes("stack trace") || t.includes("exception") || t.includes("traceback")) return true;
  if (t.includes("typescript") || t.includes("javascript") || t.includes("node.js")) return true;
  if (t.includes("npm ") || t.includes("pnpm ") || t.includes("yarn ")) return true;
  if (t.includes("vitest") || t.includes("jest") || t.includes("pytest")) return true;
  if (t.includes("compile error") || t.includes("type error") || t.includes("fails")) return true;
  if (/\b(src|lib|dist)\/[^\s]+/i.test(text)) return true;
  return false;
}

function selectFallbackProfile(config: Config, message: string): string {
  if (!config.routing.useRouter) return config.routing.defaultProfile;

  const candidates =
    config.routing.candidateProfiles.length > 0
      ? config.routing.candidateProfiles
      : Object.keys(config.profiles).filter((p) => p !== config.routing.routerProfile);

  if (candidates.length === 0) return config.routing.defaultProfile;

  if (looksLikeCodingRequest(message) && candidates.includes("coding_strong")) {
    return "coding_strong";
  }

  if (candidates.includes(config.routing.defaultProfile)) {
    return config.routing.defaultProfile;
  }

  return candidates[0]!;
}

function selectProfileName(
  config: Config,
  message: string,
  sessionKey: string,
): { profile: string; message: string } {
  const source = sourceFromSessionKey(sessionKey);
  const trimmed = message.trimStart();

  for (const binding of config.routing.bindings) {
    if (binding.when.source && binding.when.source !== source) continue;

    if (binding.when.prefix) {
      if (!trimmed.startsWith(binding.when.prefix)) continue;
      return { profile: binding.profile, message: stripPrefix(trimmed, binding.when.prefix) };
    }

    return { profile: binding.profile, message };
  }

  return { profile: selectFallbackProfile(config, message), message };
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
    const agentOptionsForProfileBase: AgentOptions = {
      ...baseAgentOptions,
      model: primaryModel ?? undefined,
    };
    const agentOptionsForProfile = applyToolPolicyToAgentOptions(
      agentOptionsForProfileBase,
      resolved.tools,
    );

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
