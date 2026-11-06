/** Public types of the tmux agent service: dependencies, results and the service interface. */
import type { Config } from "../core/types.js";
import type { AuditLog } from "./audit.js";
import type { KindTable, PermissionMode } from "./kinds.js";
import type { Registry, SessionState } from "./registry.js";
import type { TmuxRunner } from "./runner.js";
import type {
  AttachInput,
  InterruptInput,
  ListInput,
  ReadInput,
  RecoverInput,
  SendInput,
  StartInput,
  StatusInput,
  StopInput,
} from "./schemas.js";
import type { AgentState, Confidence, UntrustedOutput } from "./screen.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export interface ServiceDeps {
  config: Pick<Config, "security" | "tmuxAgents">;
  runner: TmuxRunner;
  registry: Registry;
  audit: AuditLog;
  kinds: KindTable;
  /** Kind ids that `start` accepts. */
  enabledKinds: readonly string[];
  redact: (text: string) => string;
  clock: Clock;
  /** Random source in [0, 1) for session name suffixes. */
  random?: () => number;
  /** Id of this service instance, stored in the records it creates. */
  instanceId: string;
}

export interface StartResult {
  session: string;
  project: string;
  kind: string;
  permissionMode: PermissionMode;
  cwd: string;
  attachCommand: string;
  state: AgentState;
  hint?: string;
}

export interface SessionSummary {
  session: string;
  project: string;
  kind: string;
  cwd: string;
  permissionMode: PermissionMode;
  createdAt: string;
  state: SessionState;
  lastInputAt?: string;
}

export interface StatusResult {
  session: string;
  alive: boolean;
  state: AgentState;
  signal: string;
  confidence: Confidence;
  evidence: string[];
  detector: string;
  capturedAt: string;
  /** Registry state of the session. */
  sessionState: SessionState;
}

export interface ReadResult extends UntrustedOutput {
  session: string;
  untrusted: true;
  lines: number;
}

export interface SendResult {
  session: string;
  sent: true;
  mode: "keys" | "paste";
  /** State at the end of the call (the state before sending when `waitForIdleMs` is 0). */
  state: AgentState;
  waited: boolean;
  timedOut: boolean;
  newOutput?: UntrustedOutput & { untrusted: true };
}

export interface StopResult {
  session: string;
  method: "graceful" | "kill-after-grace" | "forced";
  gone: true;
}

/** The NEW session (as `StartResult`) plus the replaced one. */
export interface RecoverResult extends StartResult {
  oldSession: string;
  method: "force-restart";
}

export interface AttachResult {
  command: string;
  readOnlyCommand: string;
}

export interface ReconcileSummary {
  adopted: number;
  lost: number;
  foreign: number;
}

export interface TmuxAgentService {
  start(input: StartInput): Promise<StartResult>;
  list(input: ListInput): Promise<{ sessions: SessionSummary[]; corrupt?: true }>;
  status(input: StatusInput): Promise<StatusResult>;
  read(input: ReadInput): Promise<ReadResult>;
  send(input: SendInput): Promise<SendResult>;
  interrupt(input: InterruptInput): Promise<{ session: string }>;
  stop(input: StopInput): Promise<StopResult>;
  recover(input: RecoverInput): Promise<RecoverResult>;
  attach(input: AttachInput): Promise<AttachResult>;
  /** Compare the registry with the live sessions of our tmux server (daemon start). Never kills anything. */
  reconcile(): Promise<ReconcileSummary>;
  /** Stop idle sessions whose last input is older than `idleReapMinutes`. Returns the reaped session names. */
  reapOnce(): Promise<string[]>;
  /** Start the idle reaper timer (no timer when `idleReapMinutes` is 0). */
  startReaper(): void;
  /** Clear the reaper timer. Kills no session: sessions outlive the daemon. */
  close(): void;
}
