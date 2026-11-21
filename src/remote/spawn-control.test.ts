import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeRemoteNewSessionConfigSchema } from "../core/types.js";
import type { RemoteBridge, RemoteControlRequest, RemoteControlResponse, RemoteSessionInfo } from "./protocol.js";
import type { SessionSpawner, SpawnedSession } from "./spawner.js";
import { withSpawnControl } from "./spawn-control.js";

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setup(opts: { enabled?: boolean; registers?: boolean; maxSessions?: number } = {}) {
  const config = ClaudeCodeRemoteNewSessionConfigSchema.parse({
    enabled: opts.enabled ?? true,
    maxSessions: opts.maxSessions ?? 3,
    minStartIntervalMs: 0,
    registerTimeoutMs: 2000,
  });
  let time = 0;
  const sessions: RemoteSessionInfo[] = [];
  const owned: SpawnedSession[] = [];
  const control = vi.fn(async (req: RemoteControlRequest): Promise<RemoteControlResponse> => {
    if (req.action === "attach") {
      const s = sessions.find((x) => String(x.index) === req.target)!;
      s.attachedChatId = req.chatId;
      return { ok: true, message: "attached", sessions };
    }
    return { ok: true, message: "ok", sessions };
  });
  const bridge = { control, isAttached: vi.fn(() => false), stop: vi.fn() } as unknown as RemoteBridge;
  const spawner: SessionSpawner = {
    socketPath: "/s/tmux.sock",
    attachArgv: (n) => ["tmux", "attach", n],
    list: async () => [...owned],
    start: vi.fn(async ({ label }) => {
      const s: SpawnedSession = { tmuxName: `pa-cc-${owned.length + 1}`, panePid: 100 + owned.length, ...(label ? { label } : {}) };
      owned.push(s);
      return s;
    }),
    stop: vi.fn(async (name: string) => {
      owned.splice(0, owned.length, ...owned.filter((o) => o.tmuxName !== name));
      return true;
    }),
  };
  const terminal = { open: vi.fn(async () => ({ opened: true, detail: "gnome-terminal" })) };
  const sleep = async (ms: number) => {
    time += ms;
    // The session registers after the first poll interval.
    if (opts.registers !== false && owned.length > sessions.length) {
      const o = owned[sessions.length]!;
      sessions.push({ index: sessions.length + 1, name: `workspace-${o.panePid}`, cwd: "/ws", pid: o.panePid });
    }
  };
  const wrapped = withSpawnControl({ config, bridge, spawner, terminal, now: () => time, sleep, logger: quiet });
  return { wrapped, control, spawner, terminal, sessions, owned };
}

describe("spawn control: new", () => {
  it("starts, opens a window, waits for registration and attaches the chat", async () => {
    const { wrapped, control, terminal, spawner } = setup();
    const res = await wrapped.control({ action: "new", chatId: "slack:U1", label: "fix; bug" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("pa-cc-1");
    expect(res.message).toContain("session 1");
    expect(res.message).toContain("gnome-terminal");
    expect(spawner.start).toHaveBeenCalledWith({ label: "fix bug" });
    expect(terminal.open).toHaveBeenCalledWith({ attachArgv: ["tmux", "attach", "pa-cc-1"], title: "fix bug (pa-cc-1)" });
    expect(control).toHaveBeenCalledWith({ action: "attach", chatId: "slack:U1", target: "1" });
  });

  it("is refused when disabled, without a chat, or over the limit", async () => {
    expect((await setup({ enabled: false }).wrapped.control({ action: "new", chatId: "slack:U1" })).message).toMatch(/disabled/);
    expect((await setup().wrapped.control({ action: "new" })).message).toMatch(/chat is required/);
    const s = setup({ maxSessions: 1 });
    expect((await s.wrapped.control({ action: "new", chatId: "slack:U1" })).ok).toBe(true);
    const second = await s.wrapped.control({ action: "new", chatId: "slack:U1" });
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/Limit reached/);
  });

  it("keeps the session and says so when it never registers", async () => {
    const { wrapped, spawner, owned } = setup({ registers: false });
    const res = await wrapped.control({ action: "new", chatId: "telegram:5" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/did not register/);
    expect(spawner.stop).not.toHaveBeenCalled();
    expect(owned).toHaveLength(1);
  });

  it("reports a start failure and a session that died at once", async () => {
    const a = setup();
    (a.spawner.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Program not found: claude"));
    expect((await a.wrapped.control({ action: "new", chatId: "slack:U1" })).message).toMatch(/Program not found/);
    const b = setup({ registers: false });
    b.spawner.list = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([]);
    const res = await b.wrapped.control({ action: "new", chatId: "slack:U1" });
    expect(res.message).toMatch(/ended at once/);
  });

  it("honors the limit and the interval for concurrent requests", async () => {
    const s = setup({ maxSessions: 1 });
    const [a, b] = await Promise.all([
      s.wrapped.control({ action: "new", chatId: "slack:U1" }),
      s.wrapped.control({ action: "new", chatId: "telegram:5" }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(s.spawner.start).toHaveBeenCalledTimes(1);
  });

  it("names the started session when a later step fails", async () => {
    const s = setup();
    s.terminal.open.mockRejectedValueOnce(new Error("spawn exploded"));
    const res = await s.wrapped.control({ action: "new", chatId: "slack:U1" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("spawn exploded");
    expect(res.message).toContain("exit pa-cc-1");
  });

  it("passes other actions to the bridge", async () => {
    const { wrapped, control } = setup();
    await wrapped.control({ action: "status" });
    expect(control).toHaveBeenCalledWith({ action: "status" });
  });
});

describe("spawn control: exit", () => {
  it("ends the session attached to the chat, or the only started one", async () => {
    const s = setup();
    await s.wrapped.control({ action: "new", chatId: "slack:U1" });
    const res = await s.wrapped.control({ action: "exit", chatId: "slack:U1" });
    expect(res).toMatchObject({ ok: true, message: "Ended pa-cc-1." });
    expect(s.spawner.stop).toHaveBeenCalledWith("pa-cc-1");
    expect((await s.wrapped.control({ action: "exit", chatId: "slack:U1" })).message).toMatch(/No session was started by new/);
  });

  it("needs a target when several exist, and accepts number, name and tmux name", async () => {
    const s = setup();
    await s.wrapped.control({ action: "new", chatId: "slack:U1", label: "alpha" });
    await s.wrapped.control({ action: "new", chatId: "slack:U2", label: "beta" });
    expect((await s.wrapped.control({ action: "exit" })).message).toMatch(/Several started sessions/);
    expect((await s.wrapped.control({ action: "exit", target: "2" })).message).toBe("Ended pa-cc-2.");
    expect((await s.wrapped.control({ action: "exit", target: "alpha" })).message).toBe("Ended pa-cc-1.");
  });

  it("reads pa-cc-N as a tmux name, not as a session number", async () => {
    const s = setup();
    s.sessions.push({ index: 1, name: "manual", cwd: "/x", pid: 5555 });
    await s.wrapped.control({ action: "new", chatId: "slack:U1" });
    expect(s.owned[0]!.tmuxName).toBe("pa-cc-1");
    const res = await s.wrapped.control({ action: "exit", target: "pa-cc-1" });
    expect(res.message).toBe("Ended pa-cc-1.");
    expect(s.spawner.stop).toHaveBeenCalledWith("pa-cc-1");
  });

  it("refuses a session that new did not start", async () => {
    const s = setup();
    await s.wrapped.control({ action: "new", chatId: "slack:U1" });
    s.sessions.push({ index: 9, name: "manual", cwd: "/x", pid: 5555 });
    const res = await s.wrapped.control({ action: "exit", target: "9" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not started by new/);
    expect(s.spawner.stop).not.toHaveBeenCalled();
    expect((await s.wrapped.control({ action: "exit", target: "nope" })).message).toMatch(/No started session/);
  });
});
