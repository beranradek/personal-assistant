import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../core/types.js";
import { createAuditLog, type AuditLog } from "./audit.js";
import { createLogger } from "../core/logger.js";
import { createBinaryResolver, type BinaryResolver } from "./binary.js";
import { KINDS, type KindTable } from "./kinds.js";
import { createRegistry, type Registry } from "./registry.js";
import { createTmuxRunner, type TmuxRunner } from "./runner.js";
import { createService } from "./service.js";
import { realClock, type Clock, type TmuxAgentService } from "./types.js";

export type { TmuxAgentService } from "./types.js";

const log = createLogger("tmux-agents");

export interface CreateTmuxAgentServiceOptions {
  /** Redaction of screen output (the daemon passes the redactor it already built). */
  redact: (text: string) => string;
  /** Who runs the service: `daemon` or `mcp-server`. Goes into the audit log. */
  caller: string;
  /** Test seams. `kinds` replaces the production kind table and enables all of its kinds. */
  kinds?: KindTable;
  runner?: TmuxRunner;
  registry?: Registry;
  audit?: AuditLog;
  clock?: Clock;
  random?: () => number;
  /** Replaces the file system check of the agent program (tests with a fake runner). */
  resolveBinary?: BinaryResolver;
  /** `PATH` of the tmux server environment (default: the `PATH` of this process, which the real runner passes on). */
  agentBasePath?: string;
}

/**
 * Build the tmux agent service. Returns `undefined` when `tmuxAgents.enabled` is false, so callers
 * register no tools at all (disabled means absent).
 */
export function createTmuxAgentService(
  config: Pick<Config, "security" | "tmuxAgents">,
  options: CreateTmuxAgentServiceOptions,
): TmuxAgentService | undefined {
  const cfg = config.tmuxAgents;
  if (!cfg.enabled) return undefined;

  const dir = path.join(config.security.dataDir, "tmux-agents");
  const kinds = options.kinds ?? KINDS;
  return createService({
    config,
    runner: options.runner ?? createTmuxRunner(cfg),
    registry: options.registry ?? createRegistry({ dir }),
    audit: options.audit ?? createAuditLog({ dir, caller: options.caller }),
    kinds,
    resolveBinary:
      options.resolveBinary ??
      createBinaryResolver(cfg, {
        kinds,
        onResolved: (kind, file, source) => log.info({ kind, path: file, source }, "Agent program resolved"),
      }),
    agentBasePath: options.agentBasePath ?? process.env["PATH"] ?? "",
    enabledKinds: options.kinds ? Object.keys(kinds) : cfg.enabledKinds,
    redact: options.redact,
    clock: options.clock ?? realClock,
    ...(options.random ? { random: options.random } : {}),
    instanceId: randomUUID(),
  });
}
