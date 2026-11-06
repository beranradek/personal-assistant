import { describe, it, expect } from "vitest";
import { TmuxAgentsConfigSchema } from "../core/types.js";
import { TmuxAgentError } from "./errors.js";
import { KINDS, buildAgentArgv, getKind, resolvePermissionMode } from "./kinds.js";

const config = (over: Record<string, unknown> = {}) => TmuxAgentsConfigSchema.parse(over);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof TmuxAgentError ? err.code : "OTHER";
  }
  return undefined;
}

describe("kinds", () => {
  it("production table has only claude", () => {
    expect(Object.keys(KINDS)).toEqual(["claude"]);
  });

  it("claude entry has the documented fields", () => {
    const claude = getKind(KINDS, "claude");
    expect(claude.allowedSlash).toEqual(["/clear", "/compact"]);
    expect(claude.multilinePaste).toBe("bracketed");
    expect(claude.exitInput).toBe("/exit");
    expect(claude.interruptKey).toBe("C-c");
    expect(claude.detector).toBe("claude@1");
  });

  it("builds argv per permission mode", () => {
    expect(buildAgentArgv(KINDS, "claude", "default")).toEqual(["claude", "--setting-sources", "user"]);
    expect(buildAgentArgv(KINDS, "claude", "acceptEdits")).toEqual([
      "claude", "--setting-sources", "user", "--permission-mode", "acceptEdits",
    ]);
    expect(buildAgentArgv(KINDS, "claude", "plan")).toEqual([
      "claude", "--setting-sources", "user", "--permission-mode", "plan",
    ]);
    expect(buildAgentArgv(KINDS, "claude", "bypass")).toEqual([
      "claude", "--setting-sources", "user", "--dangerously-skip-permissions",
    ]);
  });

  it("never puts a space or text into argv", () => {
    for (const mode of ["default", "acceptEdits", "plan", "bypass"] as const) {
      for (const arg of buildAgentArgv(KINDS, "claude", mode)) expect(arg).not.toMatch(/\s/);
    }
  });

  it("throws for an unknown kind", () => {
    expect(() => getKind(KINDS, "nope")).toThrow(TmuxAgentError);
    expect(() => buildAgentArgv(KINDS, "nope", "default")).toThrow(TmuxAgentError);
  });
});

describe("resolvePermissionMode", () => {
  it("passes non-bypass modes through", () => {
    expect(resolvePermissionMode(config(), "default", undefined)).toBe("default");
    expect(resolvePermissionMode(config(), "plan", undefined)).toBe("plan");
  });

  it("requires the setting AND the confirmation for bypass", () => {
    expect(code(() => resolvePermissionMode(config(), "bypass", true))).toBe("BYPASS_NOT_ALLOWED");
    expect(code(() => resolvePermissionMode(config({ allowPermissionBypass: true }), "bypass", undefined)))
      .toBe("BYPASS_NOT_ALLOWED");
    expect(resolvePermissionMode(config({ allowPermissionBypass: true }), "bypass", true)).toBe("bypass");
  });
});
