/**
 * Integration test: real bridge + real routes on a real HTTP server + real hook runner.
 * Only these parts are fake: Telegram sender, claude pid, stdin and stderr of the hook.
 * Timers are real and short (the bridge timers are long, so none of them fires during a test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

vi.mock("../core/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { createRemoteBridge } from "./bridge.js";
import { handleRemoteRequest, tokenMatches, type RemoteRouteHolder } from "./routes.js";
import { startHttpMcpServer, type HttpMcpServerHandle } from "../tools/http-mcp-server.js";
import { runClaudeRemoteHook, createDefaultRemoteHookDeps, type RemoteHookDeps } from "../claude/remote-hook.js";
import { ClaudeCodeRemoteConfigSchema } from "../core/types.js";
import { REMOTE_FRAME_HEADER_PREFIX, REMOTE_TOKEN_FILE, type RemoteBridge, type RemoteControlResponse } from "./protocol.js";

const TOKEN = "integration-token";
const CHAT = "111";
const CLAUDE_PID = 4242;

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function httpCall(
  port: number,
  method: string,
  urlPath: string,
  headers: http.OutgoingHttpHeaders = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("remote bridge + routes + hook (integration)", () => {
  let server: http.Server;
  let port: number;
  let configDir: string;
  let bridge: RemoteBridge;
  let sent: Array<{ chatId: string; text: string }>;
  let processing: string[];
  const aborts: AbortController[] = [];

  beforeEach(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-remote-it-"));
    fs.writeFileSync(path.join(configDir, REMOTE_TOKEN_FILE), `${TOKEN}\n`);
    sent = [];
    processing = [];
    bridge = createRemoteBridge({
      config: {
        remote: ClaudeCodeRemoteConfigSchema.parse({ enabled: true, deliveryTimeoutMs: 60_000 }),
        processingUpdateIntervalMs: 20,
      },
      sender: {
        sendMessage: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        createProcessingMessage: async (_id, text) => {
          processing.push(text);
          return "pm-1";
        },
        updateProcessingMessage: async (_id, _mid, text) => {
          processing.push(text);
        },
      },
      isPidAlive: () => true,
    });
    const holder: RemoteRouteHolder = { token: TOKEN, bridge, defaultChatId: CHAT };
    server = http.createServer((req, res) => {
      void handleRemoteRequest(req, res, holder);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ codex: { httpMcpPort: port } }));
  });

  afterEach(async () => {
    for (const a of aborts.splice(0)) a.abort();
    bridge.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  /** Hook deps with the real fetch and the real token file, but fake stdin, stderr and claude pid. */
  function hookDeps(stdin: unknown): { deps: RemoteHookDeps; stderr: string[] } {
    const stderr: string[] = [];
    const abort = new AbortController();
    aborts.push(abort);
    const deps: RemoteHookDeps = {
      ...createDefaultRemoteHookDeps(abort.signal),
      readStdin: async () => JSON.stringify(stdin),
      env: {},
      configDir,
      findClaudePid: () => CLAUDE_PID,
      isPidAlive: () => true,
      sleep: async () => undefined,
      stderr: (text) => {
        stderr.push(text);
      },
      cwd: () => "/work/project",
    };
    return { deps, stderr };
  }

  async function control(action: string, target?: string): Promise<RemoteControlResponse> {
    const res = await httpCall(
      port,
      "POST",
      "/remote/control",
      { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      JSON.stringify({ action, chatId: CHAT, ...(target ? { target } : {}) }),
    );
    expect(res.status).toBe(200);
    return JSON.parse(res.body) as RemoteControlResponse;
  }

  it("runs a full Telegram turn: register, attach, deliver, confirm, progress, one final answer, re-arm", async () => {
    // 1. SessionStart hook registers the session through its long poll.
    const start = hookDeps({ cwd: "/work/project" });
    const startRun = runClaudeRemoteHook(["listen-start"], start.deps);
    let status = await control("status");
    for (let i = 0; i < 100 && status.sessions.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = await control("status");
    }
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]).toMatchObject({ index: 1, pid: CLAUDE_PID, cwd: "/work/project" });

    // 2. Attach, then forward: the hook returns exit 2 with the frame.
    const attached = await control("attach", "1");
    expect(attached.ok).toBe(true);
    expect(bridge.isAttached(CHAT)).toBe(true);
    expect(bridge.forward(CHAT, "please list files")).toEqual({ accepted: true, msgId: 1 });
    expect(await startRun).toBe(2);
    const frame = start.stderr.join("");
    expect(frame).toContain(`${REMOTE_FRAME_HEADER_PREFIX}1]`);
    expect(frame).toContain("please list files");

    // 3. UserPromptSubmit with the frame confirms delivery (no "not delivered" notice, a turn starts).
    const submit = hookDeps({ cwd: "/work/project", prompt: `Stop hook blocking error ${frame}` });
    expect(await runClaudeRemoteHook(["UserPromptSubmit"], submit.deps)).toBe(0);

    // 4. PreToolUse produces a processing message.
    const tool = hookDeps({ cwd: "/work/project", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(await runClaudeRemoteHook(["PreToolUse"], tool.deps)).toBe(0);
    await waitFor(() => processing.length > 0, "processing message");
    expect(processing.join("\n")).toContain("Running: ls");

    // 5. Stop: exactly one final answer. The same hook then listens again (re-arm).
    const stop = hookDeps({ cwd: "/work/project", last_assistant_message: "Final answer text" });
    const stopRun = runClaudeRemoteHook(["listen-stop"], stop.deps);
    await waitFor(() => sent.some((m) => m.text === "Final answer text"), "final answer");
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.filter((m) => m.text === "Final answer text")).toHaveLength(1);
    expect(sent.some((m) => /Not delivered/i.test(m.text))).toBe(false);

    // 6. A second forward reaches the re-armed listener.
    expect(bridge.forward(CHAT, "second message")).toEqual({ accepted: true, msgId: 2 });
    expect(await stopRun).toBe(2);
    expect(stop.stderr.join("")).toContain(`${REMOTE_FRAME_HEADER_PREFIX}2]`);
  });

  it("answers 401 for empty or malformed Authorization on poll, hook and control", async () => {
    const calls: Array<[string, string]> = [
      ["GET", "/remote/poll?pid=1"],
      ["POST", "/remote/hook"],
      ["POST", "/remote/control"],
    ];
    const badHeaders: Array<http.OutgoingHttpHeaders> = [
      {},
      { Authorization: "" },
      { Authorization: "Bearer " },
      { Authorization: "Bearer" },
      { Authorization: `Basic ${TOKEN}` },
      { Authorization: TOKEN },
      { Authorization: `Bearer ${TOKEN}x` },
      { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
    ];
    for (const [method, url] of calls) {
      for (const headers of badHeaders) {
        const res = await httpCall(port, method, url, headers, method === "POST" ? "{}" : undefined);
        expect(res.status, `${method} ${url} ${JSON.stringify(headers)}`).toBe(401);
      }
    }
  });

  it("tokenMatches rejects a token of different length and a token with a trailing newline", () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false);
    expect(tokenMatches("Bearer a", TOKEN)).toBe(false);
    expect(tokenMatches(`Bearer ${TOKEN}\n`, TOKEN)).toBe(false);
    expect(tokenMatches(`Bearer ${TOKEN}`, `${TOKEN}\n`)).toBe(false);
    expect(tokenMatches(`Bearer ${TOKEN} `, TOKEN)).toBe(false);
  });

  describe("Origin check of the real HTTP server", () => {
    let handle: HttpMcpServerHandle | undefined;
    afterEach(async () => {
      await handle?.close();
      handle = undefined;
    });

    it("answers 403 for a foreign Origin on poll, hook and control, even with a valid token", async () => {
      handle = await startHttpMcpServer({} as never, 0, { token: TOKEN, bridge, defaultChatId: CHAT });
      const p = handle.port;
      const headers = { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example" };
      expect((await httpCall(p, "GET", "/remote/poll?pid=1", headers)).status).toBe(403);
      expect((await httpCall(p, "POST", "/remote/hook", headers, "{}")).status).toBe(403);
      expect((await httpCall(p, "POST", "/remote/control", headers, "{}")).status).toBe(403);
      // Same host, other port: also refused.
      const other = { Authorization: `Bearer ${TOKEN}`, Origin: `http://127.0.0.1:${p + 1}` };
      expect((await httpCall(p, "POST", "/remote/control", other, "{}")).status).toBe(403);
      // No Origin: allowed (non-browser client).
      const ok = await httpCall(p, "POST", "/remote/control", { Authorization: `Bearer ${TOKEN}` }, JSON.stringify({ action: "status" }));
      expect(ok.status).toBe(200);
    });
  });
});
