import { describe, it, expect } from "vitest";
import { parseCommand } from "./cli.js";

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
  });
});
