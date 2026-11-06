import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../core/logger.js";

const log = createLogger("tmux-agents");

/** The audit file is rotated (one backup) when it grows past this size. */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export interface AuditEntry {
  action: string;
  session?: string;
  /** The session a `recover` started (`session` is the replaced one). */
  newSession?: string;
  project?: string;
  kind?: string;
  permissionMode?: string;
  ok: boolean;
  code?: string;
  /** Text sent to the agent. Only its length and a short hash are stored, never the text. */
  input?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export interface AuditOptions {
  dir: string;
  /** Who called: for example `daemon` or `mcp-server`. */
  caller: string;
  now?: () => Date;
}

/** Fields of one line of `audit.jsonl`: `ts, action, session, project, kind, permissionMode, ok, code, inputLen, inputSha12, caller`. */
export function toAuditLine(entry: AuditEntry, caller: string, ts: Date): Record<string, unknown> {
  const { input, ...rest } = entry;
  return {
    ts: ts.toISOString(),
    ...rest,
    ...(input !== undefined
      ? { inputLen: input.length, inputSha12: createHash("sha256").update(input).digest("hex").slice(0, 12) }
      : {}),
    caller,
  };
}

/** Audit trail: one structured pino line plus one JSON line in `<dir>/audit.jsonl` (mode 0600). Never logs input text. */
export function createAuditLog(options: AuditOptions): AuditLog {
  const file = path.join(options.dir, "audit.jsonl");
  const now = options.now ?? (() => new Date());

  async function rotateIfNeeded(): Promise<void> {
    try {
      if ((await fs.stat(file)).size > AUDIT_MAX_BYTES) await fs.rename(file, `${file}.1`);
    } catch {
      // missing file: nothing to rotate
    }
  }

  return {
    async record(entry) {
      const line = toAuditLine(entry, options.caller, now());
      if (entry.ok) log.info(line, "tmux agent action");
      else log.warn(line, "tmux agent action failed");
      try {
        await fs.mkdir(options.dir, { recursive: true, mode: 0o700 });
        await rotateIfNeeded();
        await fs.appendFile(file, `${JSON.stringify(line)}\n`, { encoding: "utf-8", mode: 0o600 });
      } catch (err) {
        // An audit failure must not break the operation that was already done.
        log.error({ err, file }, "Could not write the tmux agent audit file");
      }
    },
  };
}
