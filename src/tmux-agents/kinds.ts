import type { TmuxAgentsConfig } from "../core/types.js";
import { TmuxAgentError } from "./errors.js";

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** One supported agent program. A new kind needs one entry here and one detector in `screen.ts`. */
export interface AgentKind {
  id: string;
  /** Fixed argv of the agent. Contains no user text. */
  command: readonly string[];
  /** Extra argv per permission mode. */
  modes: Readonly<Record<PermissionMode, readonly string[]>>;
  /** Text typed (then Enter) for a graceful exit. A constant of the kind, never user input. */
  exitInput: string;
  interruptKey: "C-c";
  /** Detector id in `screen.ts`, for example `claude@1`. */
  detector: string;
  /** Slash commands that `send` may start with. */
  allowedSlash: readonly string[];
  /** Whether multi-line text can be pasted (bracketed paste). With `none` the service rejects multi-line text. */
  multilinePaste: "bracketed" | "none";
}

export type KindTable = Readonly<Record<string, AgentKind>>;

/** Production table. Tests inject their own table through `createTmuxAgentService`. */
export const KINDS: KindTable = {
  claude: {
    id: "claude",
    // `--setting-sources user`: project and local settings (hooks, allow rules) are not loaded (D20).
    command: ["claude", "--setting-sources", "user"],
    modes: {
      default: [],
      acceptEdits: ["--permission-mode", "acceptEdits"],
      plan: ["--permission-mode", "plan"],
      bypass: ["--dangerously-skip-permissions"],
    },
    exitInput: "/exit",
    interruptKey: "C-c",
    detector: "claude@1",
    allowedSlash: ["/clear", "/compact"],
    multilinePaste: "bracketed",
  },
};

export function getKind(kinds: KindTable, id: string): AgentKind {
  const kind = Object.hasOwn(kinds, id) ? kinds[id] : undefined;
  if (!kind) throw new TmuxAgentError("INVALID_INPUT", `Unknown agent kind: ${id}`);
  return kind;
}

export function buildAgentArgv(kinds: KindTable, kindId: string, mode: PermissionMode): string[] {
  const kind = getKind(kinds, kindId);
  return [...kind.command, ...kind.modes[mode]];
}

/**
 * Check the permission mode against the settings. `bypass` needs `allowPermissionBypass` AND `confirmBypass: true`.
 * The confirmation literal is self-asserted by the caller; the settings gate is the real barrier.
 */
export function resolvePermissionMode(
  config: Pick<TmuxAgentsConfig, "allowPermissionBypass">,
  mode: PermissionMode,
  confirmBypass: boolean | undefined,
): PermissionMode {
  if (mode === "bypass" && !(config.allowPermissionBypass && confirmBypass === true)) {
    throw new TmuxAgentError(
      "BYPASS_NOT_ALLOWED",
      "Bypass mode needs tmuxAgents.allowPermissionBypass=true in settings and confirmBypass=true",
    );
  }
  return mode;
}
