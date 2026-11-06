import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { TmuxAgentError } from "./errors.js";
import { TMUX_TOOLS, findTmuxTool, toMcpDefinition } from "./tools.js";
import type { TmuxAgentService } from "./types.js";

const NAMES = [
  "agent_session_start",
  "agent_session_list",
  "agent_session_status",
  "agent_session_read",
  "agent_session_send",
  "agent_session_interrupt",
  "agent_session_stop",
  "agent_session_recover",
  "agent_session_attach",
];

function fakeService(over: Partial<Record<keyof TmuxAgentService, unknown>> = {}): TmuxAgentService {
  const fn = () => vi.fn().mockResolvedValue({ session: "pa-x-1a2b" });
  return {
    start: fn(), list: fn(), status: fn(), read: fn(), send: fn(), interrupt: fn(), stop: fn(), recover: fn(), attach: fn(),
    reconcile: fn(), reapOnce: fn(), startReaper: vi.fn(), close: vi.fn(),
    ...over,
  } as unknown as TmuxAgentService;
}

async function call(name: string, args: unknown, service = fakeService()) {
  const result = await findTmuxTool(name)!.run(service, args);
  return { result, payload: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

describe("TMUX_TOOLS", () => {
  it("has exactly the nine tool names", () => {
    expect(TMUX_TOOLS.map((t) => t.name)).toEqual(NAMES);
  });

  it("annotates read-only and destructive tools", () => {
    const by = (name: string) => findTmuxTool(name)!.annotations;
    for (const name of ["list", "status", "read", "attach"]) expect(by(`agent_session_${name}`).readOnlyHint).toBe(true);
    for (const name of ["stop", "recover"]) expect(by(`agent_session_${name}`).destructiveHint).toBe(true);
    for (const name of ["start", "send", "interrupt"]) {
      expect(by(`agent_session_${name}`)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it("descriptions carry the safety rules", () => {
    const text = (n: string) => findTmuxTool(n)!.description;
    expect(text("agent_session_read")).toMatch(/untrusted/);
    expect(text("agent_session_send")).toMatch(/untrusted/);
    expect(text("agent_session_send")).toMatch(/'!', '#' or '\/'/);
    expect(text("agent_session_start")).toMatch(/bypass/);
    expect(text("agent_session_stop")).toMatch(/userConfirmed/);
    expect(text("agent_session_recover")).toMatch(/lost/);
  });

  describe("input validation", () => {
    it.each(["pa-x", "foo", "pa-x-1a2b; ls", "PA-x-1a2b", ""])("rejects session %j", async (session) => {
      for (const name of ["status", "read", "send", "interrupt", "stop", "attach", "recover"]) {
        const { result, payload } = await call(`agent_session_${name}`, { session, text: "hi", userConfirmed: true });
        expect(result.isError).toBe(true);
        expect(payload).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      }
    });

    it("rejects confirmBypass: false and userConfirmed: false", async () => {
      const start = await call("agent_session_start", { project: "p", directory: "/x", permissionMode: "bypass", confirmBypass: false });
      expect(start.payload.error.code).toBe("INVALID_INPUT");
      const stop = await call("agent_session_stop", { session: "pa-x-1a2b", force: true, userConfirmed: false });
      expect(stop.payload.error.code).toBe("INVALID_INPUT");
      const recover = await call("agent_session_recover", { session: "pa-x-1a2b", userConfirmed: false });
      expect(recover.payload.error.code).toBe("INVALID_INPUT");
    });

    it("rejects a bad project name", async () => {
      const { payload } = await call("agent_session_start", { project: "Bad Name", directory: "/x" });
      expect(payload.error.code).toBe("INVALID_INPUT");
      expect(payload.error.message).toMatch(/project/);
    });

    it("applies defaults before calling the service", async () => {
      const service = fakeService();
      await call("agent_session_start", { project: "p", directory: "/x" }, service);
      expect(service.start).toHaveBeenCalledWith({ project: "p", directory: "/x", kind: "claude", permissionMode: "default" });
      await call("agent_session_read", { session: "pa-x-1a2b" }, service);
      // `lines` has no schema default: the service applies tmuxAgents.defaultOutputLines
      expect(service.read).toHaveBeenCalledWith({ session: "pa-x-1a2b" });
      await call("agent_session_send", { session: "pa-x-1a2b", text: "hi" }, service);
      expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ allowUnknownState: false, queueWhileBusy: false }));
    });
  });

  describe("result mapping", () => {
    it("wraps success as { ok: true, ... }", async () => {
      const { result, payload } = await call("agent_session_status", { session: "pa-x-1a2b" });
      expect(result.isError).toBeUndefined();
      expect(payload).toEqual({ ok: true, session: "pa-x-1a2b" });
    });

    it("maps service errors to { ok: false, error: { code, message } }", async () => {
      const service = fakeService({ status: vi.fn().mockRejectedValue(new TmuxAgentError("NOT_FOUND", "Unknown session")) });
      const { result, payload } = await call("agent_session_status", { session: "pa-x-1a2b" }, service);
      expect(result.isError).toBe(true);
      expect(payload).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "Unknown session" } });
    });

    it("hides the message of unexpected errors", async () => {
      const service = fakeService({ status: vi.fn().mockRejectedValue(new Error("secret path /home/x")) });
      const { payload } = await call("agent_session_status", { session: "pa-x-1a2b" }, service);
      expect(payload.error).toEqual({ code: "TMUX_ERROR", message: "Unexpected error" });
    });

    it("the input guard reaches the tool layer: '!ls' and ' /permissions' give INVALID_INPUT from the service", async () => {
      const rejecting = vi.fn().mockRejectedValue(new TmuxAgentError("INVALID_INPUT", "Text must not start with '!'"));
      const service = fakeService({ send: rejecting });
      for (const text of ["!ls", " /permissions"]) {
        const { payload } = await call("agent_session_send", { session: "pa-x-1a2b", text }, service);
        expect(payload.error.code).toBe("INVALID_INPUT");
      }
      expect(rejecting).toHaveBeenCalledTimes(2);
    });
  });

  describe("skill and docs", () => {
    const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), "utf-8");
    const files: Record<string, string> = {
      "SKILL.md": read("../templates/skills/tmux-agents/SKILL.md"),
      "agent-tools.md": read("../../docs/agent-tools.md"),
      "tmux_agents.md": read("../../docs/settings/tmux_agents.md"),
    };

    it.each(Object.keys(files))("%s mentions only tools that exist", (name) => {
      const mentioned = new Set(files[name]!.match(/agent_session_\w+/g) ?? []);
      expect(mentioned.size).toBeGreaterThan(0);
      for (const tool of mentioned) expect(NAMES).toContain(tool);
    });

    it("the tools table in agent-tools.md lists all nine tools", () => {
      for (const name of NAMES) expect(files["agent-tools.md"]).toContain(`\`${name}\``);
    });

    it("the skill has the frontmatter fields", () => {
      expect(files["SKILL.md"]).toMatch(/^---\nname: "tmux-agents"\ndescription: ".+"\nversion: "\d{4}-\d{2}-\d{2}"\n---\n/);
    });

    it("the new text has no line over 140 characters and no em dash", () => {
      const toolsSection = files["agent-tools.md"]!.split("## Tmux Agent Tools (optional)")[1]!.split("\n---")[0]!;
      for (const text of [files["SKILL.md"]!, files["tmux_agents.md"]!, toolsSection]) {
        for (const line of text.split("\n")) {
          expect(line.length).toBeLessThanOrEqual(140);
          expect(line).not.toContain("—");
        }
      }
    });
  });

  describe("JSON schema (D2)", () => {
    const schemaOf = (name: string) => toMcpDefinition(findTmuxTool(name)!).inputSchema as { required?: string[] };

    it("is an object schema without $schema", () => {
      for (const tool of TMUX_TOOLS) {
        const def = toMcpDefinition(tool);
        expect(def.inputSchema.type).toBe("object");
        expect(def.inputSchema).not.toHaveProperty("$schema");
      }
    });

    it("requires only fields without a default", () => {
      expect(schemaOf("agent_session_start").required).toEqual(expect.arrayContaining(["project", "directory"]));
      for (const field of ["kind", "permissionMode", "confirmBypass"]) {
        expect(schemaOf("agent_session_start").required).not.toContain(field);
      }
      expect(schemaOf("agent_session_read").required).toEqual(["session"]);
      expect(schemaOf("agent_session_list").required ?? []).not.toContain("includeStopped");
      const send = schemaOf("agent_session_send").required;
      expect(send).toEqual(expect.arrayContaining(["session", "text"]));
      for (const field of ["waitForIdleMs", "queueWhileBusy", "answerPermissionPrompt"]) expect(send).not.toContain(field);
    });

    it("matches what the zod shape accepts", () => {
      const shape = findTmuxTool("agent_session_start")!.shape;
      expect(z.object(shape).safeParse({ project: "p", directory: "/x" }).success).toBe(true);
    });
  });
});
