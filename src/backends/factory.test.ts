import { describe, it, expect, vi } from "vitest";

vi.mock("./claude.js", () => ({
  createClaudeBackend: vi.fn().mockReturnValue({ name: "claude" }),
}));
vi.mock("./codex.js", () => ({
  createCodexBackend: vi.fn().mockResolvedValue({ name: "codex" }),
}));

import { createBackend } from "./factory.js";
import { createCodexBackend } from "./codex.js";
import { DEFAULTS } from "../core/config.js";
import type { Config } from "../core/types.js";
import type { AgentOptions } from "../core/agent-runner.js";

function makeConfig(backend: "claude" | "codex"): Config {
  return {
    ...DEFAULTS,
    agent: { ...DEFAULTS.agent, backend },
  };
}

const mockAgentOptions = {} as AgentOptions;

describe("createBackend", () => {
  it("creates claude backend when config.agent.backend is 'claude'", async () => {
    const backend = await createBackend(makeConfig("claude"), mockAgentOptions);
    expect(backend.name).toBe("claude");
  });

  it("creates routed backend when routing is enabled", async () => {
    const config: Config = {
      ...DEFAULTS,
      routing: {
        enabled: true,
        routerProfile: "router",
        defaultProfile: "research",
        maxRouterMs: 1500,
        bindings: [],
      },
      profiles: {
        router: { backend: "local_llama", model: { type: "gguf", path: "/tmp/router.gguf" }, tools: { allow: [], deny: [] } },
        research: { backend: "claude", model: "anthropic/claude-haiku", tools: { allow: [], deny: [] } },
      },
    };

    const backend = await createBackend(config, mockAgentOptions);
    expect(backend.name).toBe("routed");
  });

  it("creates codex backend when config.agent.backend is 'codex'", async () => {
    const backend = await createBackend(makeConfig("codex"));
    expect(backend.name).toBe("codex");
  });

  it("throws when Claude backend is requested without agentOptions", async () => {
    await expect(createBackend(makeConfig("claude"))).rejects.toThrow(
      "AgentOptions required for Claude backend",
    );
  });

  it("forwards configDir to codex backend", async () => {
    await createBackend(makeConfig("codex"), undefined, { configDir: "/custom/config" });
    expect(createCodexBackend).toHaveBeenCalledWith(
      expect.anything(),
      { configDir: "/custom/config" },
    );
  });
});
