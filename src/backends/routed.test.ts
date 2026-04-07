import { describe, it, expect } from "vitest";
import type { AgentBackend } from "./interface.js";
import type { AgentOptions } from "../core/agent-runner.js";
import { DEFAULTS } from "../core/config.js";
import type { Config } from "../core/types.js";
import { createRoutedBackend } from "./routed.js";

function makeConfig(): Config {
  return {
    ...DEFAULTS,
    routing: {
      enabled: true,
      routerProfile: "router",
      defaultProfile: "research",
      maxRouterMs: 1500,
      bindings: [
        { when: { source: "telegram", prefix: "/code" }, profile: "coding_strong" },
      ],
    },
    profiles: {
      router: { backend: "local_llama", model: { type: "gguf", path: "/tmp/router.gguf" }, tools: { allow: [], deny: [] } },
      research: { backend: "claude", model: "anthropic/claude-haiku", tools: { allow: [], deny: [] } },
      coding_strong: { backend: "codex", model: "openai/gpt-5", tools: { allow: [], deny: [] } },
    },
  };
}

const baseAgentOptions = { maxTurns: 10 } as AgentOptions;

function makeBackend(label: string): AgentBackend {
  return {
    name: label,
    async *runTurn() {
      yield { type: "result", response: label, messages: [], partial: false };
    },
    async runTurnSync(message: string) {
      return { response: `${label}:${message}`, messages: [], partial: false };
    },
    clearSession() {},
  };
}

describe("createRoutedBackend", () => {
  it("routes by source+prefix and strips the prefix", async () => {
    const config = makeConfig();

    const backend = await createRoutedBackend(
      config,
      baseAgentOptions,
      undefined,
      async (cfg) => makeBackend(cfg.agent.backend),
    );

    const res = await backend.runTurnSync("   /code do the thing", "telegram--123");
    expect(res.response).toBe("codex:do the thing");
  });

  it("falls back to defaultProfile when no binding matches", async () => {
    const config = makeConfig();

    const backend = await createRoutedBackend(
      config,
      baseAgentOptions,
      undefined,
      async (cfg) => makeBackend(cfg.agent.backend),
    );

    const res = await backend.runTurnSync("hello", "telegram--123");
    expect(res.response).toBe("claude:hello");
  });
});
