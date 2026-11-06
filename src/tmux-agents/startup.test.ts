import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../core/logger.js", () => ({ createLogger: () => mockLog }));

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("./index.js", () => ({ createTmuxAgentService: mockCreate }));

import { TmuxAgentsConfigSchema } from "../core/types.js";
import { startTmuxAgentService } from "./startup.js";

function config(tmuxAgents: Record<string, unknown>, allowedCommands: string[] = ["ls"]) {
  return {
    security: { allowedCommands },
    tmuxAgents: { ...TmuxAgentsConfigSchema.parse(tmuxAgents), socketPath: "/data/tmux-agents/tmux.sock" },
  } as never;
}

function fakeService() {
  return { reconcile: vi.fn().mockResolvedValue({ adopted: 1, lost: 0, foreign: 0 }), startReaper: vi.fn(), close: vi.fn() };
}

const options = { redact: (t: string) => t, caller: "daemon", reaper: true };

describe("startTmuxAgentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined and creates nothing when disabled or when the block is missing", async () => {
    expect(await startTmuxAgentService(config({ enabled: false }), options)).toBeUndefined();
    expect(await startTmuxAgentService({ security: {} } as never, options)).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it("returns undefined when the factory returns nothing", async () => {
    mockCreate.mockReturnValue(undefined);
    expect(await startTmuxAgentService(config({ enabled: true }), options)).toBeUndefined();
  });

  it("creates the service, logs the settings, reconciles once and starts the reaper", async () => {
    const service = fakeService();
    mockCreate.mockReturnValue(service);
    const cfg = config({ enabled: true, allowedRoots: ["/srv/a", "/srv/b"], trustedRoots: ["/srv/a"], maxSessions: 2 });

    expect(await startTmuxAgentService(cfg, options)).toBe(service);

    expect(mockCreate).toHaveBeenCalledWith(cfg, options);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: "/data/tmux-agents/tmux.sock", allowedRoots: 2, trustedRoots: 1, maxSessions: 2, bypassAllowed: false,
      }),
      "Tmux agent sessions enabled",
    );
    expect(service.reconcile).toHaveBeenCalledTimes(1);
    expect(service.startReaper).toHaveBeenCalledTimes(1);
  });

  it("does not start the reaper in a process that is not the daemon", async () => {
    const service = fakeService();
    mockCreate.mockReturnValue(service);
    await startTmuxAgentService(config({ enabled: true }), { ...options, caller: "mcp-server", reaper: false });
    expect(service.reconcile).toHaveBeenCalledTimes(1);
    expect(service.startReaper).not.toHaveBeenCalled();
  });

  it("warns when tmux is in the Bash allowlist and stays quiet without it", async () => {
    mockCreate.mockReturnValue(fakeService());
    await startTmuxAgentService(config({ enabled: true }, ["ls", "tmux"]), options);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("'tmux' is in security.allowedCommands"));

    mockLog.warn.mockClear();
    await startTmuxAgentService(config({ enabled: true }, ["ls"]), options);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("continues when reconcile fails", async () => {
    const service = fakeService();
    service.reconcile.mockRejectedValue(new Error("tmux not found"));
    mockCreate.mockReturnValue(service);
    expect(await startTmuxAgentService(config({ enabled: true }), options)).toBe(service);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Could not reconcile tmux agent sessions",
    );
    expect(service.startReaper).toHaveBeenCalled();
  });
});
