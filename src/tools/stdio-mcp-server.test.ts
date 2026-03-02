import { describe, it, expect, vi } from "vitest";
import { createStdioMcpServer, type StdioMcpServerDeps } from "./stdio-mcp-server.js";

function makeDeps(overrides: Partial<StdioMcpServerDeps> = {}): StdioMcpServerDeps {
  return {
    search: vi.fn().mockResolvedValue([]),
    handleCronAction: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    handleExec: vi.fn().mockResolvedValue({ success: true, output: "" }),
    getProcessSession: vi.fn().mockReturnValue(undefined),
    listProcessSessions: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe("createStdioMcpServer", () => {
  it("creates a server instance", () => {
    const server = createStdioMcpServer(makeDeps());
    expect(server).toBeDefined();
  });
});
