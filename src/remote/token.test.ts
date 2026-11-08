import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRemoteToken, generateRemoteToken, writeRemoteToken, readRemoteToken, remoteTokenPath } from "./token.js";

describe("remote token", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pa-remote-token-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes a 64 char hex token with mode 0600 and leaves no temp file", async () => {
    const handle = await createRemoteToken(dir);
    expect(handle.token).toMatch(/^[0-9a-f]{64}$/);
    expect(handle.path).toBe(remoteTokenPath(dir));
    expect((await fs.stat(handle.path)).mode & 0o777).toBe(0o600);
    expect(await readRemoteToken(dir)).toBe(handle.token);
    expect(await fs.readdir(dir)).toEqual(["remote-token"]);
  });

  it("creates a different token each time and replaces the file", async () => {
    const first = await createRemoteToken(dir);
    const second = await createRemoteToken(dir);
    expect(second.token).not.toBe(first.token);
    expect(await readRemoteToken(dir)).toBe(second.token);
  });

  it("remove deletes the file and can run twice", async () => {
    const handle = await createRemoteToken(dir);
    await handle.remove();
    await handle.remove();
    expect(await readRemoteToken(dir)).toBeUndefined();
  });

  it("generateRemoteToken writes nothing", async () => {
    expect(generateRemoteToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("remove keeps a file that holds another token", async () => {
    const mine = await writeRemoteToken(dir, generateRemoteToken());
    const other = await writeRemoteToken(dir, generateRemoteToken());
    await mine.remove();
    expect(await readRemoteToken(dir)).toBe(other.token);
    await other.remove();
    expect(await readRemoteToken(dir)).toBeUndefined();
  });

  it("creates the config dir when missing", async () => {
    const nested = path.join(dir, "a", "b");
    const handle = await createRemoteToken(nested);
    expect(await readRemoteToken(nested)).toBe(handle.token);
  });
});
