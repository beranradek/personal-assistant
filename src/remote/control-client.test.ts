import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRemoteControlClient } from "./control-client.js";
import { createRemoteToken } from "./token.js";

describe("createRemoteControlClient", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pa-remote-client-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fails clearly when the token file is missing", async () => {
    const fetchImpl = vi.fn();
    const control = createRemoteControlClient({ configDir: dir, port: 1, fetchImpl });
    await expect(control({ action: "status" })).rejects.toThrow(/token file is missing/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the request with the bearer token and returns the body", async () => {
    const { token } = await createRemoteToken(dir);
    const body = { ok: true, message: "m", sessions: [] };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const control = createRemoteControlClient({ configDir: dir, port: 4321, fetchImpl });
    expect(await control({ action: "attach", target: "1" })).toEqual(body);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4321/remote/control");
    expect(init.headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(init.body)).toEqual({ action: "attach", target: "1" });
  });

  it("maps 401, 503, other errors and network errors to clear messages", async () => {
    await createRemoteToken(dir);
    const make = (fetchImpl: typeof fetch) => createRemoteControlClient({ configDir: dir, port: 1, fetchImpl });
    await expect(make(vi.fn().mockResolvedValue(new Response("", { status: 401 })))({ action: "status" })).rejects.toThrow(/rejected/);
    await expect(make(vi.fn().mockResolvedValue(new Response("", { status: 503 })))({ action: "status" })).rejects.toThrow(/not ready/);
    await expect(make(vi.fn().mockResolvedValue(new Response("", { status: 500 })))({ action: "status" })).rejects.toThrow(/HTTP 500/);
    await expect(make(vi.fn().mockRejectedValue(new TypeError("fetch failed")))({ action: "status" })).rejects.toThrow(/not reachable/);
  });
});
