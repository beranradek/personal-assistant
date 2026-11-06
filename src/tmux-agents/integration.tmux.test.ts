/**
 * Integration test with a REAL tmux server (private socket) and a fake agent. Skipped when tmux is missing.
 * Besides the service flow it proves the tmux behaviors that the plan only assumed: id targets (`$N`, `%N`), `new-session -P -F`,
 * a command given as several argv elements, `load-buffer -` from stdin, bracketed paste, `=name` targets, and that text
 * is never interpreted by a shell.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { TmuxAgentsConfigSchema } from "../core/types.js";
import { CONSERVATIVE_PATTERNS, createRedactor } from "../security/content-redaction.js";
import { createTmuxAgentService } from "./index.js";
import type { AgentKind, KindTable } from "./kinds.js";
import type { Clock, TmuxAgentService } from "./types.js";

const run = promisify(execFile);
const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;
const FAKE_AGENT = new URL("./fixtures/fake-agent.mjs", import.meta.url).pathname;

/** Real time, but waits are capped so the whole test stays fast. */
const fastClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 400))),
};

describe.skipIf(!tmuxAvailable)("tmux integration (real tmux, fake agent)", { timeout: 30_000 }, () => {
  let base: string;
  let socket: string;
  let root: string;
  let projectDir: string;
  let messageLog: string;
  let service: TmuxAgentService;
  let kinds: KindTable;

  const tmux = async (...args: string[]) => run("tmux", ["-S", socket, ...args]).catch((err: { stdout?: string; stderr?: string }) => err);

  function makeService(socketPath = socket): TmuxAgentService {
    const tmuxAgents = TmuxAgentsConfigSchema.parse({
      enabled: true,
      socketPath,
      allowedRoots: [root],
      minStartIntervalMs: 0,
      minSendIntervalMs: 0,
      maxSessions: 5,
      stopGraceMs: 1_000,
    });
    const created = createTmuxAgentService(
      { security: { workspace: path.join(base, "ws"), additionalWriteDirs: [], dataDir: path.join(base, "data") }, tmuxAgents } as never,
      { redact: createRedactor(CONSERVATIVE_PATTERNS), caller: "test", kinds, clock: fastClock },
    );
    if (!created) throw new Error("service disabled");
    return created;
  }

  const startInput = (project: string) => ({
    project,
    directory: projectDir,
    kind: "fake",
    permissionMode: "default" as const,
  });

  const sendInput = (session: string, text: string, waitForIdleMs = 0) => ({
    session,
    text,
    waitForIdleMs,
    queueWhileBusy: false,
    answerPermissionPrompt: false,
  });

  const loggedMessages = () =>
    (fs.existsSync(messageLog) ? fs.readFileSync(messageLog, "utf-8").trim().split("\n").filter(Boolean) : []).map(
      (line) => (JSON.parse(line) as { message: string }).message,
    );

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync("/tmp/pa-it-"));
    socket = path.join(base, "t.sock");
    root = path.join(base, "root");
    projectDir = path.join(root, "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    messageLog = path.join(base, "messages.jsonl");
    const fake: AgentKind = {
      id: "fake",
      command: ["node", FAKE_AGENT, messageLog, "600"],
      modes: { default: [], acceptEdits: [], plan: [], bypass: [] },
      exitInput: "/exit",
      interruptKey: "C-c",
      detector: "claude@1",
      allowedSlash: ["/clear"],
      multilinePaste: "bracketed",
    };
    kinds = { fake };
    service = makeService();
  });

  afterAll(async () => {
    service?.close();
    await tmux("kill-server");
    // our private server must be gone
    const after = await tmux("list-sessions");
    expect(`${after.stderr ?? ""}`).toMatch(/no server running|error connecting/);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("starts the agent with id targets, reports idle, and answers a message", async () => {
    const started = await service.start(startInput("ab"));
    expect(started.session).toMatch(/^pa-ab-[0-9a-f]{4}$/);
    expect(started.state).toBe("idle");

    const status = await service.status({ session: started.session });
    expect(status).toMatchObject({ alive: true, state: "idle" });

    const result = await service.send(sendInput(started.session, "hello agent", 8_000));
    expect(result).toMatchObject({ mode: "keys", waited: true, timedOut: false, state: "idle" });
    expect(result.newOutput?.output).toContain("● echo: hello agent");
    expect(loggedMessages()).toEqual(["hello agent"]);
  });

  it("multi-line text is pasted as ONE message", async () => {
    const [session] = (await service.list({ includeStopped: false })).sessions;
    const result = await service.send(sendInput(session!.session, "line one\nline two", 8_000));
    expect(result).toMatchObject({ mode: "paste", state: "idle" });
    expect(loggedMessages().at(-1)).toBe("line one\nline two");
    expect(result.newOutput?.output).toContain("line one | line two");
  });

  it("session_attached is 0 for a session without a client (the idle reaper skips attached sessions)", async () => {
    const [session] = (await service.list({ includeStopped: false })).sessions;
    const result = await tmux("list-sessions", "-F", "#{session_name} #{session_attached}");
    expect(`${result.stdout ?? ""}`.split("\n")).toContain(`${session!.session} 0`);
  });

  // `-u` is a safeguard: tmux 3.6 on the dev machine also passes this test without it, so it proves no regression, not the need.
  it("captures non-ASCII screen characters (❯) when the daemon runs in the C locale", async () => {
    const lang = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
    const saved = lang.map((name) => [name, process.env[name]] as const);
    for (const name of lang) process.env[name] = "C";
    const otherSocket = path.join(base, "nolang.sock");
    let other: TmuxAgentService | undefined;
    try {
      other = makeService(otherSocket); // the runner copies the environment, now with the C locale
      const started = await other.start(startInput("nolang"));
      expect(started.state).toBe("idle"); // the idle detector needs the ❯ prompt character
      expect((await other.read({ session: started.session, lines: 20 })).output).toContain("❯");
      await other.stop({ session: started.session, force: true, userConfirmed: true });
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      other?.close();
      await run("tmux", ["-S", otherSocket, "kill-server"]).catch(() => undefined);
    }
  });

  it("finds the program in a well-known location outside the PATH and appends its directory to the session PATH", async () => {
    const installDir = path.join(base, "home", ".local", "bin");
    const pathLog = path.join(base, "agent-path.txt");
    fs.mkdirSync(installDir, { recursive: true });
    const program = path.join(installDir, "wrapagent");
    fs.writeFileSync(program, `#!/bin/sh\necho "$PATH" > "${pathLog}"\nexec node "$@"\n`, { mode: 0o755 });
    const wrapKind: AgentKind = {
      ...kinds["fake"]!,
      id: "wrap",
      command: ["wrapagent", FAKE_AGENT, messageLog, "600"],
      knownLocations: [program],
    };
    const autoSocket = path.join(base, "auto.sock");
    const tmuxAgents = TmuxAgentsConfigSchema.parse({
      enabled: true, socketPath: autoSocket, allowedRoots: [root], minStartIntervalMs: 0, minSendIntervalMs: 0, stopGraceMs: 1_000,
    });
    const auto = createTmuxAgentService(
      {
        security: { workspace: path.join(base, "ws"), additionalWriteDirs: [], dataDir: path.join(base, "data-auto") },
        tmuxAgents,
      } as never,
      { redact: createRedactor(CONSERVATIVE_PATTERNS), caller: "test", kinds: { wrap: wrapKind }, clock: fastClock },
    );
    if (!auto) throw new Error("service disabled");
    try {
      const started = await auto.start({ ...startInput("auto"), kind: "wrap" });
      expect(started.state).toBe("idle");
      // the directory of the program is APPENDED: it cannot shadow system tools, siblings are still found
      expect(fs.readFileSync(pathLog, "utf-8").trim().split(":").at(-1)).toBe(installDir);
      await auto.stop({ session: started.session, force: true, userConfirmed: true });
    } finally {
      auto.close();
      await run("tmux", ["-S", autoSocket, "kill-server"]).catch(() => undefined);
    }
  });

  it("text ending in ';' arrives unchanged (tmux would eat it as a command separator)", async () => {
    const [session] = (await service.list({ includeStopped: false })).sessions;
    await service.send(sendInput(session!.session, "echo done;;", 8_000));
    await service.send(sendInput(session!.session, "path\\;", 8_000));
    expect(loggedMessages().slice(-2)).toEqual(["echo done;;", "path\\;"]);
  });

  it("never lets a shell interpret the text", async () => {
    const [session] = (await service.list({ includeStopped: false })).sessions;
    const pwned = path.join(base, "pwned");
    await service.send(sendInput(session!.session, `$(touch ${pwned}) \`touch ${pwned}\` ; touch ${pwned}`, 8_000));
    expect(fs.existsSync(pwned)).toBe(false);
    expect(loggedMessages().at(-1)).toBe(`$(touch ${pwned}) \`touch ${pwned}\` ; touch ${pwned}`);
  });

  it("targets only its own sessions by id and never confuses prefix-sharing labels", async () => {
    const abc = await service.start(startInput("abc"));
    // a foreign session on the SAME private socket
    await tmux("new-session", "-d", "-s", "other", "sleep 300");

    const listed = (await service.list({ includeStopped: false })).sessions.map((s) => s.session);
    expect(listed).toHaveLength(2);
    expect(listed).not.toContain("other");

    const ab = listed.find((name) => name.startsWith("pa-ab-"))!;
    const stopped = await service.stop({ session: abc.session, force: true, userConfirmed: true });
    expect(stopped.method).toBe("forced");

    const live = (await tmux("list-sessions", "-F", "#{session_name}")).stdout ?? "";
    expect(live).toContain("other");
    expect(live).toContain(ab);
    expect(live).not.toContain(abc.session);
    expect((await service.status({ session: ab })).alive).toBe(true);
  });

  it("the =name target form used by the attach command parses", async () => {
    const [session] = (await service.list({ includeStopped: false })).sessions;
    const attach = await service.attach({ session: session!.session, readOnly: true });
    expect(attach.command).toContain(`-t '=${session!.session}'`);
    const result = await tmux("has-session", "-t", `=${session!.session}`);
    expect((result as { code?: number }).code).toBeUndefined(); // no error object: exit code 0
  });

  it("a restarted service adopts the surviving session and can talk to it", async () => {
    const restarted = makeService();
    const summary = await restarted.reconcile();
    expect(summary).toMatchObject({ adopted: 1, lost: 0, foreign: 0 });
    const [session] = (await restarted.list({ includeStopped: false })).sessions;
    expect(session!.state).toBe("running");
    const result = await restarted.send(sendInput(session!.session, "after restart", 8_000));
    expect(result.newOutput?.output).toContain("● echo: after restart");
  });

  it("stops gracefully with /exit", async () => {
    const fresh = await service.start(startInput("grace"));
    const stopped = await service.stop({ session: fresh.session, force: false });
    expect(stopped.method).toBe("graceful");
    expect((await service.status({ session: fresh.session })).alive).toBe(false);
  });

  it("kills after the grace period when the agent ignores /exit", async () => {
    const stubborn = await service.start(startInput("stubborn"));
    await service.send(sendInput(stubborn.session, "HANG", 8_000));
    const stopped = await service.stop({ session: stubborn.session, force: false });
    expect(stopped.method).toBe("kill-after-grace");
    const live = (await tmux("list-sessions", "-F", "#{session_name}")).stdout ?? "";
    expect(live).not.toContain(stubborn.session);
  });

  it("recover restarts a session in the same directory", async () => {
    const old = (await service.list({ includeStopped: false })).sessions.find((s) => s.session.startsWith("pa-ab-"))!;
    const recovered = await service.recover({ session: old.session, userConfirmed: true });
    expect(recovered).toMatchObject({ oldSession: old.session, cwd: projectDir });
    expect(recovered.session).not.toBe(old.session);
    expect((await service.status({ session: recovered.session })).alive).toBe(true);
  });

  it("stops everything it started and leaves the foreign session alone", async () => {
    for (const s of (await service.list({ includeStopped: false })).sessions) {
      await service.stop({ session: s.session, force: true, userConfirmed: true });
    }
    const live = ((await tmux("list-sessions", "-F", "#{session_name}")).stdout ?? "").trim().split("\n");
    expect(live).toEqual(["other"]);
    expect(os.platform()).toBeTruthy();
  });
});
