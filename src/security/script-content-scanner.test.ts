import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { validateScriptContentFromShellCommand } from "./script-content-scanner.js";

describe("validateScriptContentFromShellCommand", () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-script-scan-"));
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const security = {
    scriptContentPolicy: {
      enabled: true,
      maxBytes: 200_000,
      denyStdinExecution: true,
      denyMissingScriptFile: true,
      scanInline: true,
    },
  } as const;

  it("blocks executing a script that references /etc/passwd", async () => {
    const scriptPath = path.join(workspaceDir, "evil.sh");
    fs.writeFileSync(scriptPath, "cat /etc/passwd\n", "utf8");

    const result = await validateScriptContentFromShellCommand("bash evil.sh", {
      workspaceDir,
      security: security as unknown as Record<string, unknown>,
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\/etc\/passwd/);
    }
  });

  it("blocks executing a script that appears to contain a hardcoded secret", async () => {
    const scriptPath = path.join(workspaceDir, "secret.sh");
    fs.writeFileSync(
      scriptPath,
      'export OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz0123456789"\n',
      "utf8",
    );

    const result = await validateScriptContentFromShellCommand("bash secret.sh", {
      workspaceDir,
      security: security as unknown as Record<string, unknown>,
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/hardcoded secret/i);
    }
  });

  it("blocks stdin-piped shell execution (curl | bash)", async () => {
    const result = await validateScriptContentFromShellCommand(
      "echo hi | bash",
      { workspaceDir, security: security as unknown as Record<string, unknown> },
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/stdin/i);
    }
  });

  it("scans inline -c content and blocks sensitive reads", async () => {
    const result = await validateScriptContentFromShellCommand(
      'bash -c "cat /etc/shadow"',
      { workspaceDir, security: security as unknown as Record<string, unknown> },
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/\/etc\/shadow/);
    }
  });

  it("allows a simple safe script", async () => {
    const scriptPath = path.join(workspaceDir, "ok.sh");
    fs.writeFileSync(scriptPath, "echo OK\n", "utf8");

    const result = await validateScriptContentFromShellCommand("bash ok.sh", {
      workspaceDir,
      security: security as unknown as Record<string, unknown>,
    });

    expect(result.allowed).toBe(true);
  });
});

