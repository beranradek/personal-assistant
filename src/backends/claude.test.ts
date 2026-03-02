import { describe, it, expect, vi } from "vitest";

// Mock agent-runner before importing claude backend
vi.mock("../core/agent-runner.js", () => ({
  streamAgentTurn: vi.fn(),
  runAgentTurn: vi.fn(),
  clearSdkSession: vi.fn(),
}));

import { createClaudeBackend } from "./claude.js";
import type { AgentOptions } from "../core/agent-runner.js";
import type { Config } from "../core/types.js";
import { DEFAULTS } from "../core/config.js";

const mockAgentOptions = {} as AgentOptions;
const mockConfig = DEFAULTS;

describe("createClaudeBackend", () => {
  it("returns a backend with name 'claude'", () => {
    const backend = createClaudeBackend(mockAgentOptions, mockConfig);
    expect(backend.name).toBe("claude");
  });

  it("has runTurn, runTurnSync, clearSession methods", () => {
    const backend = createClaudeBackend(mockAgentOptions, mockConfig);
    expect(typeof backend.runTurn).toBe("function");
    expect(typeof backend.runTurnSync).toBe("function");
    expect(typeof backend.clearSession).toBe("function");
  });

  it("clearSession delegates to clearSdkSession", async () => {
    const { clearSdkSession } = await import("../core/agent-runner.js");
    const backend = createClaudeBackend(mockAgentOptions, mockConfig);
    backend.clearSession("test-session");
    expect(clearSdkSession).toHaveBeenCalledWith("test-session");
  });
});
