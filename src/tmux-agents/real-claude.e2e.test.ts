/**
 * End-to-end test with a REAL tmux server and a REAL Claude Code agent (it calls the model: a few short prompts).
 * Skipped unless `PA_E2E_REAL_CLAUDE=1`. Needs tmux, `claude` (logged in) and a project directory that Claude Code already trusts:
 *
 *   PA_E2E_REAL_CLAUDE=1 PA_E2E_PROJECT_DIR=/home/me/dev/some-trusted-project npx vitest run src/tmux-agents/real-claude.e2e.test.ts
 *
 * It proves that `send` returns the COMPLETE answer of exactly the message it sent (from the agent hooks), also when the answer
 * is much longer than the visible pane, and that nothing is read from another session.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TmuxAgentsConfigSchema } from "../core/types.js";
import { CONSERVATIVE_PATTERNS, createRedactor } from "../security/content-redaction.js";
import { createTmuxAgentService } from "./index.js";
import type { TmuxAgentService } from "./types.js";

const enabled = process.env.PA_E2E_REAL_CLAUDE === "1" && spawnSync("tmux", ["-V"]).status === 0;
const projectDir = process.env.PA_E2E_PROJECT_DIR ?? "";

describe.skipIf(!enabled || projectDir === "")("real Claude Code agent: exact answers", { timeout: 300_000 }, () => {
  let base: string;
  let service: TmuxAgentService;
  const sessions: string[] = [];

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync("/tmp/pa-e2e-"));
    const tmuxAgents = TmuxAgentsConfigSchema.parse({
      enabled: true,
      socketPath: path.join(base, "t.sock"),
      allowedRoots: [path.dirname(projectDir)],
      minStartIntervalMs: 0,
      minSendIntervalMs: 0,
      maxSessions: 3,
    });
    const created = createTmuxAgentService(
      { security: { workspace: path.join(base, "ws"), additionalWriteDirs: [], dataDir: path.join(base, "data") }, tmuxAgents } as never,
      { redact: createRedactor(CONSERVATIVE_PATTERNS), caller: "e2e" },
    );
    if (!created) throw new Error("service disabled");
    service = created;
  });

  afterAll(async () => {
    for (const session of sessions) await service.stop({ session, force: true, userConfirmed: true }).catch(() => undefined);
    fs.rmSync(base, { recursive: true, force: true });
  });

  const send = (session: string, text: string) =>
    service.send({ session, text, waitForIdleMs: 240_000, queueWhileBusy: false, answerPermissionPrompt: false });

  it("returns the complete answer of each message from the hooks, even when it is far longer than the pane", async () => {
    const started = await service.start({ project: "e2e", directory: projectDir, kind: "claude", permissionMode: "default" });
    sessions.push(started.session);
    // The TUI may need a moment after the start before its screen is recognized.
    for (let i = 0; i < 30 && (await service.status({ session: started.session })).state !== "idle"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect((await service.status({ session: started.session })).state).toBe("idle");

    const long = await send(started.session, "Print the integers from 1 to 150, each on its own line. Output nothing else. Do not use any tool.");
    const diagnostics = async () =>
      `state=${long.state} timedOut=${long.timedOut} screen:\n${(await service.read({ session: started.session, lines: 60 })).output}`;
    expect(long.newOutput?.source, long.newOutput?.source === "hook" ? "" : await diagnostics()).toBe("hook");
    const lines = long.newOutput!.output.trim().split("\n").map((l) => l.trim());
    expect(lines).toHaveLength(150);
    expect(lines[0]).toBe("1");
    expect(lines[149]).toBe("150");

    const short = await send(started.session, "Reply with exactly the single word: pong. Do not use any tool.");
    expect(short.newOutput?.source, `short answer, screen was: ${short.newOutput?.output.slice(-300)}`).toBe("hook");
    expect(short.newOutput!.output.trim().toLowerCase()).toBe("pong");
    // the answer of the previous message is not mixed in
    expect(short.newOutput!.output).not.toContain("150");
  });
});
