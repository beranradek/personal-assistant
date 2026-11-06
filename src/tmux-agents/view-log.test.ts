import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createViewLog, VIEW_LOG_MAX_BYTES } from "./view-log.js";

describe("createViewLog", () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pa-view-log-")), "tmux-agents");
  });
  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("appends one line per error with a timestamp, in a 0600 file inside a 0700 directory", () => {
    const log = createViewLog(dir, () => new Date("2026-11-06T12:00:00.000Z"));
    log(new Error("tmux split-window failed:\nno space for new pane"));
    log("plain string");
    const file = path.join(dir, "view.log");
    expect(fs.readFileSync(file, "utf-8")).toBe(
      "2026-11-06T12:00:00.000Z tmux split-window failed: no space for new pane\n2026-11-06T12:00:00.000Z plain string\n",
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("truncates a long message", () => {
    createViewLog(dir)(new Error("x".repeat(5_000)));
    expect(fs.readFileSync(path.join(dir, "view.log"), "utf-8").length).toBeLessThan(600);
  });

  it("rotates to one backup when the file is too big", () => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "view.log");
    fs.writeFileSync(file, "y".repeat(VIEW_LOG_MAX_BYTES + 1));
    createViewLog(dir)(new Error("fresh"));
    expect(fs.readFileSync(`${file}.1`, "utf-8")).toHaveLength(VIEW_LOG_MAX_BYTES + 1);
    expect(fs.readFileSync(file, "utf-8")).toContain("fresh");
  });

  it("never throws when the log cannot be written", () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, "a file where the directory should be");
    expect(() => createViewLog(dir)(new Error("boom"))).not.toThrow();
  });
});
