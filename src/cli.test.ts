import { describe, it, expect, vi } from "vitest";
import { parseCommand, parseReflectDate } from "./cli.js";

describe("cli", () => {
  describe("parseCommand", () => {
    it('parses "terminal" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "terminal"]);
      expect(result).toBe("terminal");
    });

    it('parses "daemon" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "daemon"]);
      expect(result).toBe("daemon");
    });

    it('parses "init" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "init"]);
      expect(result).toBe("init");
    });

    it("returns null for unknown subcommand", () => {
      const result = parseCommand(["node", "cli.js", "unknown"]);
      expect(result).toBeNull();
    });

    it("returns null when no subcommand given", () => {
      const result = parseCommand(["node", "cli.js"]);
      expect(result).toBeNull();
    });

    it("ignores --config flag when finding subcommand", () => {
      const result = parseCommand(["node", "cli.js", "--config", "/path/settings.json", "terminal"]);
      expect(result).toBe("terminal");
    });

    it("does not treat --help as a subcommand", () => {
      const result = parseCommand(["node", "cli.js", "--help"]);
      expect(result).toBeNull();
    });

    it('parses "reflect" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "reflect"]);
      expect(result).toBe("reflect");
    });
  });

  describe("parseReflectDate", () => {
    it("returns undefined when --date flag is absent", () => {
      expect(parseReflectDate(["node", "cli.js", "reflect"])).toBeUndefined();
    });

    it("returns the date string when --date YYYY-MM-DD is provided", () => {
      expect(
        parseReflectDate(["node", "cli.js", "reflect", "--date", "2026-04-01"]),
      ).toBe("2026-04-01");
    });

    it("returns undefined when --date appears without value", () => {
      // No value after --date means i+1 is out of bounds — treated as missing
      expect(parseReflectDate(["node", "cli.js", "reflect", "--date"])).toBeUndefined();
    });

    it("exits with error for malformed date", () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
      expect(() =>
        parseReflectDate(["node", "cli.js", "reflect", "--date", "not-a-date"]),
      ).toThrow();
      exitSpy.mockRestore();
    });
  });
});
