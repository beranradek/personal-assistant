/**
 * Test helper (excluded from the build): an in-memory stand-in for a tmux server behind the `TmuxRunner` interface,
 * and a fake clock. Records every call so tests can assert argv, ordering and stdin.
 */
import type { Clock } from "./types.js";
import type { TmuxRunner, TmuxRunOptions, TmuxRunResult } from "./runner.js";

export interface FakeSession {
  name: string;
  id: string;
  paneId: string;
  created: string;
  cwd: string;
  argv: string[];
  /** Screen text; a function lets a test change the screen between captures. */
  screen: string | (() => string);
  /** Keys sent with `send-keys` (each call as one string). */
  keys: string[];
  pasted: string[];
}

export interface FakeCall {
  args: string[];
  input?: string;
}

export class FakeClock implements Clock {
  t = Date.UTC(2026, 10, 6, 10, 0, 0);
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

const ok = (stdout = ""): TmuxRunResult => ({ code: 0, stdout, stderr: "", noServer: false });
const fail = (stderr: string, noServer = false): TmuxRunResult => ({ code: 1, stdout: "", stderr, noServer });

export class FakeTmux implements TmuxRunner {
  readonly socketPath = "/tmp/fake-tmux/tmux.sock";
  readonly calls: FakeCall[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly buffers = new Map<string, string>();
  /** Called after every `send-keys`; lets a test react (for example end the session on /exit). */
  onSendKeys?: (session: FakeSession, keys: string[]) => void;
  /** Return a result to override the default handling of a call. */
  override?: (args: readonly string[]) => TmuxRunResult | undefined;
  defaultScreen = "";
  private nextId = 1;
  private createdCounter = 1_700_000_000;

  subcommands(): string[] {
    return [...new Set(this.calls.map((c) => c.args[0]!))];
  }

  callsOf(subcommand: string): FakeCall[] {
    return this.calls.filter((c) => c.args[0] === subcommand);
  }

  /** Create a session directly, like another process would. */
  addSession(name: string, screen = this.defaultScreen): FakeSession {
    const n = this.nextId++;
    const session: FakeSession = {
      name, id: `$${n}`, paneId: `%${n}`, created: String(this.createdCounter++), cwd: "/", argv: [], screen, keys: [], pasted: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  byName(name: string): FakeSession {
    const found = [...this.sessions.values()].find((s) => s.name === name);
    if (!found) throw new Error(`no fake session ${name}`);
    return found;
  }

  private target(args: readonly string[]): FakeSession | undefined {
    const value = args[args.indexOf("-t") + 1];
    return [...this.sessions.values()].find((s) => s.id === value || s.paneId === value);
  }

  async run(args: readonly string[], options?: TmuxRunOptions): Promise<TmuxRunResult> {
    this.calls.push({ args: [...args], ...(options?.input !== undefined ? { input: options.input } : {}) });
    const overridden = this.override?.(args);
    if (overridden) return overridden;
    const noServer = this.sessions.size === 0;
    switch (args[0]) {
      case "new-session": {
        const name = args[args.indexOf("-s") + 1]!;
        if ([...this.sessions.values()].some((s) => s.name === name)) return fail(`duplicate session: ${name}`);
        const session = this.addSession(name);
        session.cwd = args[args.indexOf("-c") + 1]!;
        session.argv = args.slice(args.indexOf("--") + 1);
        return ok(`${session.id} ${session.paneId} ${session.created}\n`);
      }
      case "list-sessions":
        if (noServer) return fail("no server running on /tmp/fake", true);
        return ok([...this.sessions.values()].map((s) => `${s.name} ${s.id} ${s.created}`).join("\n") + "\n");
      case "has-session":
        if (noServer) return fail("no server running on /tmp/fake", true);
        return this.target(args) ? ok() : fail("can't find session");
      case "display-message": {
        if (noServer) return fail("no server running on /tmp/fake", true);
        const session = this.target(args);
        return session ? ok(`${session.id} ${session.created}\n`) : fail("can't find pane");
      }
      case "capture-pane": {
        const session = this.target(args);
        if (!session) return fail("can't find pane");
        return ok(typeof session.screen === "function" ? session.screen() : session.screen);
      }
      case "send-keys": {
        const session = this.target(args);
        if (!session) return fail("can't find pane");
        const keys = args.slice(args.indexOf("-t") + 2);
        session.keys.push(keys.join(" "));
        this.onSendKeys?.(session, keys);
        return ok();
      }
      case "load-buffer":
        this.buffers.set(args[args.indexOf("-b") + 1]!, options?.input ?? "");
        return ok();
      case "paste-buffer": {
        const session = this.target(args);
        const name = args[args.indexOf("-b") + 1]!;
        if (!session || !this.buffers.has(name)) return fail("no buffer");
        session.pasted.push(this.buffers.get(name)!);
        if (args.includes("-d")) this.buffers.delete(name);
        return ok();
      }
      case "delete-buffer":
        this.buffers.delete(args[args.indexOf("-b") + 1]!);
        return ok();
      case "kill-session": {
        const session = this.target(args);
        if (!session) return fail("can't find session");
        this.sessions.delete(session.id);
        return ok();
      }
      default:
        return fail(`unknown command ${args[0]}`);
    }
  }
}
