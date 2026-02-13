import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addSession,
  getSession,
  markExited,
  listSessions,
  cleanExpired,
  clearAll,
} from "./process-registry.js";

describe("process registry", () => {
  beforeEach(() => {
    clearAll();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // addSession
  // -------------------------------------------------------------------------
  describe("addSession", () => {
    it("registers a process and returns a session ID", () => {
      const id = addSession("ls -la", 1234);

      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("stores the command and pid in the session", () => {
      const id = addSession("echo hello", 5678);
      const session = getSession(id);

      expect(session).toBeDefined();
      expect(session!.command).toBe("echo hello");
      expect(session!.pid).toBe(5678);
    });

    it("initializes session with null exitCode and empty output", () => {
      const id = addSession("node app.js", 9999);
      const session = getSession(id);

      expect(session!.exitCode).toBeNull();
      expect(session!.output).toBe("");
      expect(session!.exitedAt).toBeNull();
    });

    it("sets startedAt to an ISO-8601 timestamp", () => {
      const id = addSession("date", 1111);
      const session = getSession(id);

      expect(session!.startedAt).toBeDefined();
      const parsed = new Date(session!.startedAt);
      expect(parsed.toISOString()).toBe(session!.startedAt);
    });

    it("generates unique IDs for different sessions", () => {
      const id1 = addSession("cmd1", 1);
      const id2 = addSession("cmd2", 2);

      expect(id1).not.toBe(id2);
    });
  });

  // -------------------------------------------------------------------------
  // getSession
  // -------------------------------------------------------------------------
  describe("getSession", () => {
    it("retrieves a session by ID", () => {
      const id = addSession("ls", 100);
      const session = getSession(id);

      expect(session).toBeDefined();
      expect(session!.pid).toBe(100);
    });

    it("returns undefined for unknown ID", () => {
      const session = getSession("nonexistent-id");

      expect(session).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // markExited
  // -------------------------------------------------------------------------
  describe("markExited", () => {
    it("updates exitCode on the session", () => {
      const id = addSession("node script.js", 200);
      markExited(id, 0);

      const session = getSession(id);
      expect(session!.exitCode).toBe(0);
    });

    it("sets exitedAt to an ISO-8601 timestamp", () => {
      const id = addSession("npm test", 300);
      markExited(id, 1);

      const session = getSession(id);
      expect(session!.exitedAt).not.toBeNull();
      const parsed = new Date(session!.exitedAt!);
      expect(parsed.toISOString()).toBe(session!.exitedAt);
    });

    it("stores non-zero exit codes", () => {
      const id = addSession("failing-command", 400);
      markExited(id, 137);

      const session = getSession(id);
      expect(session!.exitCode).toBe(137);
    });

    it("does nothing for unknown ID (no throw)", () => {
      expect(() => markExited("unknown-id", 0)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // listSessions
  // -------------------------------------------------------------------------
  describe("listSessions", () => {
    it("returns all active sessions", () => {
      addSession("cmd1", 1);
      addSession("cmd2", 2);
      addSession("cmd3", 3);

      const sessions = listSessions();
      expect(sessions).toHaveLength(3);
    });

    it("returns entries with id and session properties", () => {
      const id = addSession("ls", 100);
      const sessions = listSessions();

      expect(sessions[0].id).toBe(id);
      expect(sessions[0].session.pid).toBe(100);
      expect(sessions[0].session.command).toBe("ls");
    });

    it("returns empty array when no sessions exist", () => {
      const sessions = listSessions();
      expect(sessions).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // cleanExpired (30-minute TTL)
  // -------------------------------------------------------------------------
  describe("cleanExpired", () => {
    it("removes sessions older than 30 minutes TTL", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-15T10:00:00.000Z"));

      const id = addSession("old-process", 500);
      markExited(id, 0);

      // Advance time by 31 minutes
      vi.setSystemTime(new Date("2025-06-15T10:31:00.000Z"));
      cleanExpired();

      expect(getSession(id)).toBeUndefined();
      expect(listSessions()).toHaveLength(0);
    });

    it("keeps sessions younger than 30 minutes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-15T10:00:00.000Z"));

      const id = addSession("recent-process", 600);

      // Advance time by 29 minutes
      vi.setSystemTime(new Date("2025-06-15T10:29:00.000Z"));
      cleanExpired();

      expect(getSession(id)).toBeDefined();
    });

    it("removes only expired sessions, keeps recent ones", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-15T10:00:00.000Z"));

      const oldId = addSession("old", 700);
      markExited(oldId, 0);

      // Advance 20 minutes and add a new session
      vi.setSystemTime(new Date("2025-06-15T10:20:00.000Z"));
      const newId = addSession("new", 800);

      // Advance to 31 minutes past first session
      vi.setSystemTime(new Date("2025-06-15T10:31:00.000Z"));
      cleanExpired();

      expect(getSession(oldId)).toBeUndefined();
      expect(getSession(newId)).toBeDefined();
      expect(listSessions()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // clearAll (for tests)
  // -------------------------------------------------------------------------
  describe("clearAll", () => {
    it("removes all sessions", () => {
      addSession("a", 1);
      addSession("b", 2);

      clearAll();

      expect(listSessions()).toEqual([]);
    });
  });
});
