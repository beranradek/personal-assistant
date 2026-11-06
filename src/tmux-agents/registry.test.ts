import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRegistry, pruneTerminal, reconcile, type SessionRecord, type LiveSession } from "./registry.js";

/** Lets one test make the write of `owner.json` fail (ESM namespaces cannot be spied on). */
const ownerWrite = vi.hoisted(() => ({ failNext: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: ((file: Parameters<typeof actual.writeFile>[0], ...rest: unknown[]) => {
      if (ownerWrite.failNext && String(file).endsWith("owner.json")) {
        ownerWrite.failNext = false;
        return Promise.reject(new Error("disk full"));
      }
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(file, ...rest);
    }) as typeof actual.writeFile,
  };
});

function record(name: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    project: "proj",
    kind: "claude",
    cwd: "/srv/proj",
    permissionMode: "default",
    createdAt: "2026-11-06T10:00:00.000Z",
    creatorPid: process.pid,
    instanceId: "inst-1",
    tmuxSessionId: "$1",
    tmuxPaneId: "%1",
    tmuxCreated: "1000",
    state: "running",
    ...over,
  };
}

/** Create a lock directory as if another process held it. */
function holdLock(lockDir: string, owner: { token: string; pid?: number; ageMs?: number }): void {
  fs.mkdirSync(lockDir, { recursive: true });
  const ts = Date.now() - (owner.ageMs ?? 0);
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: owner.pid ?? process.pid, ts, token: owner.token }));
}

describe("registry", () => {
  let dir: string;
  const file = () => path.join(dir, "registry.json");

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-")), "tmux-agents");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("reads an empty registry when the file is missing", async () => {
    expect(await createRegistry({ dir }).read()).toEqual({ records: [], corrupt: false });
  });

  it("adds, updates and lists records through mutate", async () => {
    const registry = createRegistry({ dir });
    await registry.mutate((records) => ({ records: [...records, record("pa-a-0001")], result: undefined }));
    await registry.mutate((records) => ({
      records: records.map((r) => (r.name === "pa-a-0001" ? { ...r, state: "stopped" as const } : r)),
      result: undefined,
    }));
    const { records } = await registry.read();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: "pa-a-0001", state: "stopped" });
  });

  it("returns the result of the mutation", async () => {
    const registry = createRegistry({ dir });
    const result = await registry.mutate((records) => ({ records, result: records.length + 41 }));
    expect(result).toBe(41);
  });

  it("writes atomically: file mode 0600, dir mode 0700, no .tmp or lock left", async () => {
    const registry = createRegistry({ dir });
    await registry.mutate((records) => ({ records: [...records, record("pa-a-0001")], result: undefined }));
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual(["registry.json"]);
  });

  it("treats corrupt JSON as empty plus corrupt flag and refuses to overwrite it", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(), "{not json");
    const registry = createRegistry({ dir });
    expect(await registry.read()).toEqual({ records: [], corrupt: true });
    await expect(registry.mutate((records) => ({ records, result: 1 }))).rejects.toThrow(/registry corrupt/);
    expect(fs.readFileSync(file(), "utf-8")).toBe("{not json");
    expect(fs.existsSync(`${file()}.lock`)).toBe(false);
  });

  it("treats a schema violation (unknown field) as corrupt", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, sessions: [{ ...record("pa-a-0001"), extra: 1 }] }));
    expect((await createRegistry({ dir }).read()).corrupt).toBe(true);
  });

  it("a second writer waits for the lock", async () => {
    const registry = createRegistry({ dir, lockPollMs: 5 });
    // hold the lock manually to prove that mutate waits
    holdLock(`${file()}.lock`, { token: "held" });
    const order: string[] = [];
    const pending = registry.mutate((records) => {
      order.push("mutated");
      return { records, result: undefined };
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(order).toEqual([]);
    order.push("released");
    fs.rmSync(`${file()}.lock`, { recursive: true, force: true });
    await pending;
    expect(order).toEqual(["released", "mutated"]);
  });

  it("times out when the lock stays held", async () => {
    holdLock(`${file()}.lock`, { token: "held" });
    const registry = createRegistry({ dir, lockWaitMs: 50, lockPollMs: 5 });
    await expect(registry.mutate((records) => ({ records, result: 1 }))).rejects.toMatchObject({ code: "TMUX_ERROR" });
  });

  it("takes over a stale lock (old timestamp)", async () => {
    holdLock(`${file()}.lock`, { token: "old", ageMs: 60_000 });
    const registry = createRegistry({ dir, lockPollMs: 5 });
    await registry.mutate((records) => ({ records: [...records, record("pa-a-0001")], result: undefined }));
    expect((await registry.read()).records).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual(["registry.json"]);
  });

  it("takes over a lock whose owner process is dead and the lock is older than the minimum age", async () => {
    holdLock(`${file()}.lock`, { token: "dead", pid: 999_999, ageMs: 5_000 });
    const registry = createRegistry({ dir, lockPollMs: 5, isPidAlive: () => false });
    await registry.mutate((records) => ({ records: [...records, record("pa-a-0001")], result: undefined }));
    expect((await registry.read()).records).toHaveLength(1);
  });

  it("does not take over a fresh lock only because its pid looks dead (other PID namespace)", async () => {
    holdLock(`${file()}.lock`, { token: "fresh", pid: 999_999 });
    const registry = createRegistry({ dir, lockWaitMs: 60, lockPollMs: 5, isPidAlive: () => false });
    await expect(registry.mutate((records) => ({ records, result: 1 }))).rejects.toMatchObject({ code: "TMUX_ERROR" });
    expect(fs.existsSync(`${file()}.lock`)).toBe(true);
  });

  it("removes leftover .stale-* lock directories of crashed processes, keeps fresh ones", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const old = `${file()}.lock.stale-1-aaaa`;
    const fresh = `${file()}.lock.stale-2-bbbb`;
    fs.mkdirSync(old);
    fs.mkdirSync(fresh);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    await createRegistry({ dir }).mutate((records) => ({ records, result: undefined }));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("does not leave a lock directory behind when owner.json cannot be written", async () => {
    const registry = createRegistry({ dir });
    ownerWrite.failNext = true;
    await expect(registry.mutate((records) => ({ records, result: 1 }))).rejects.toThrow("disk full");
    expect(fs.existsSync(`${file()}.lock`)).toBe(false);
    await registry.mutate((records) => ({ records, result: 1 }));
  });

  it("parallel writers lose no entry (several rounds)", async () => {
    const registry = createRegistry({ dir, lockPollMs: 2 });
    for (let round = 0; round < 5; round++) {
      await Promise.all(
        [0, 1, 2, 3].map((i) =>
          registry.mutate((records) => ({ records: [...records, record(`pa-r${round}-000${i}`)], result: undefined })),
        ),
      );
    }
    expect((await registry.read()).records).toHaveLength(20);
    expect(fs.readdirSync(dir)).toEqual(["registry.json"]);
  });

  it("parallel stale-lock takeovers end with exactly one winner per round and no lost entry", async () => {
    for (let round = 0; round < 5; round++) {
      const roundDir = path.join(dir, `round${round}`);
      holdLock(path.join(roundDir, "registry.json.lock"), { token: "old", ageMs: 60_000 });
      const a = createRegistry({ dir: roundDir, lockPollMs: 2 });
      const b = createRegistry({ dir: roundDir, lockPollMs: 2 });
      await Promise.all([
        a.mutate((records) => ({ records: [...records, record("pa-a-0001")], result: undefined })),
        b.mutate((records) => ({ records: [...records, record("pa-b-0002", { tmuxSessionId: "$2" })], result: undefined })),
      ]);
      const names = (await a.read()).records.map((r) => r.name).sort();
      expect(names).toEqual(["pa-a-0001", "pa-b-0002"]);
      expect(fs.readdirSync(roundDir)).toEqual(["registry.json"]);
    }
  });

  it("does not hold the lock while the caller works outside mutate", async () => {
    const registry = createRegistry({ dir });
    await registry.mutate((records) => ({ records, result: undefined }));
    expect(fs.existsSync(`${file()}.lock`)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20)); // a fake tmux call
    expect(fs.existsSync(`${file()}.lock`)).toBe(false);
  });

  it("does not remove a lock that was taken over by someone else on release", async () => {
    const registry = createRegistry({ dir, lockPollMs: 2 });
    await registry.mutate((records) => {
      // simulate a takeover while we work: replace the lock owner
      holdLock(`${file()}.lock`, { token: "other" });
      return { records, result: undefined };
    });
    expect(fs.existsSync(`${file()}.lock`)).toBe(true);
  });
});

describe("pruneTerminal", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-11-20T10:00:00.000Z");

  it("keeps running records and recently ended ones, drops old stopped and lost ones", () => {
    const records = [
      record("pa-a-0001"),
      record("pa-b-0002", { state: "stopped", endedAt: new Date(now - 1 * DAY).toISOString() }),
      record("pa-c-0003", { state: "stopped", endedAt: new Date(now - 8 * DAY).toISOString() }),
      record("pa-d-0004", { state: "lost", endedAt: new Date(now - 30 * DAY).toISOString() }),
    ];
    expect(pruneTerminal(records, now).map((r) => r.name)).toEqual(["pa-a-0001", "pa-b-0002"]);
  });

  it("uses the last activity for records without endedAt", () => {
    const old = record("pa-a-0001", { state: "stopped", createdAt: new Date(now - 20 * DAY).toISOString() });
    const active = record("pa-b-0002", {
      state: "stopped",
      createdAt: new Date(now - 20 * DAY).toISOString(),
      lastInputAt: new Date(now - DAY).toISOString(),
    });
    expect(pruneTerminal([old, active], now).map((r) => r.name)).toEqual(["pa-b-0002"]);
  });

  it("never drops a running record, however old", () => {
    const running = record("pa-a-0001", { createdAt: new Date(now - 90 * DAY).toISOString() });
    expect(pruneTerminal([running], now)).toHaveLength(1);
  });
});

describe("reconcile", () => {
  const live = (name: string, sessionId: string, created = "1000"): LiveSession => ({ name, sessionId, created });

  it("adopts running records that are alive with the same id and creation time", () => {
    const result = reconcile([record("pa-a-0001")], [live("pa-a-0001", "$1")], "pa-");
    expect(result.adopt.map((r) => r.name)).toEqual(["pa-a-0001"]);
    expect(result.markLost).toEqual([]);
    expect(result.ignoreForeign).toEqual([]);
  });

  it("marks running records without a live session as lost", () => {
    const result = reconcile([record("pa-a-0001")], [], "pa-");
    expect(result.markLost.map((r) => r.name)).toEqual(["pa-a-0001"]);
  });

  it("reports live sessions with our prefix and no record as foreign, ignores others", () => {
    const result = reconcile([], [live("pa-x-9999", "$7"), live("mine", "$8")], "pa-");
    expect(result.ignoreForeign.map((l) => l.name)).toEqual(["pa-x-9999"]);
  });

  it("same name with a different id: lost plus foreign", () => {
    const result = reconcile([record("pa-a-0001")], [live("pa-a-0001", "$5", "2000")], "pa-");
    expect(result.markLost.map((r) => r.name)).toEqual(["pa-a-0001"]);
    expect(result.ignoreForeign.map((l) => l.sessionId)).toEqual(["$5"]);
  });

  it("same id with a different creation time (reused id after a server restart) is lost", () => {
    const result = reconcile([record("pa-a-0001")], [live("pa-a-0001", "$1", "5000")], "pa-");
    expect(result.adopt).toEqual([]);
    expect(result.markLost).toHaveLength(1);
  });

  it("ignores records that are not running", () => {
    const result = reconcile([record("pa-a-0001", { state: "stopped" })], [], "pa-");
    expect(result).toEqual({ adopt: [], markLost: [], ignoreForeign: [] });
  });
});
