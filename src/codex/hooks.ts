import { bashSecurityHook } from "../security/bash-hook.js";
import type { Config } from "../core/types.js";

type UnknownRecord = Record<string, unknown>;

async function readStdinJson(maxBytes = 1_000_000): Promise<UnknownRecord> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`stdin JSON too large (>${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as UnknownRecord;
}

function getString(obj: UnknownRecord, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function getRecord(obj: UnknownRecord, key: string): UnknownRecord | null {
  const v = obj[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as UnknownRecord;
}

/**
 * Handle Codex Hooks `PreToolUse` event for Bash tool.
 *
 * Notes:
 * - PreToolUse is currently a guardrail, not a complete enforcement boundary.
 * - Codex expects JSON output on stdout only when we want to block.
 */
export async function handleCodexPreToolUseHook(config: Config): Promise<void> {
  const payload = await readStdinJson();

  const toolName = getString(payload, "tool_name") ?? "Bash";
  const toolInput = getRecord(payload, "tool_input") ?? {};
  const toolUseId = getString(payload, "tool_use_id") ?? undefined;

  const result = await bashSecurityHook(
    { tool_name: toolName, tool_input: toolInput },
    toolUseId,
    { workspaceDir: config.security.workspace, config },
  );

  const decision = (result as UnknownRecord)["decision"];
  const reason = (result as UnknownRecord)["reason"];

  if (decision === "block") {
    const msg = typeof reason === "string" ? reason : "Blocked by policy";
    process.stdout.write(
      JSON.stringify({
        systemMessage: msg,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: msg,
        },
      }) + "\n",
    );
  }
}

