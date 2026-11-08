/**
 * Remote session protocol
 * =======================
 *
 * Shared types for the remote interactive session feature: Telegram -> PA daemon (RemoteBridge) -> long poll ->
 * `pa claude-remote-hook` (asyncRewake hook) -> live Claude Code session. See
 * docs/plans/active/2026-11-08-remote-interactive-session-communication/implementation-plan.md (section Protocol).
 */

/** Token file name inside the PA config directory (mode 0600, created by the daemon when remote mode is enabled). */
export const REMOTE_TOKEN_FILE = "remote-token";

/** Max time (ms) one long poll waits before answering 204. */
export const REMOTE_POLL_TIMEOUT_MS = 55_000;

/** Header set on a 204 poll answer when a newer poll for the same pid took over. */
export const REMOTE_REPLACED_HEADER = "x-remote-replaced";

/**
 * Header of each message frame printed by the hook (stderr, exit 2). The text after it is `<msgId>]`.
 * The bridge confirms delivery only when a `UserPromptSubmit` prompt contains `REMOTE_FRAME_HEADER_PREFIX + msgId + "]"`.
 */
export const REMOTE_FRAME_HEADER_PREFIX = "[Message from the user, id ";

/**
 * The frame asks the model to start its reply with one line that repeats the user's message (no label, no prefix). The
 * terminal shows it as a normal assistant line (Claude Code hides the hook feedback text). The bridge removes that line
 * before Telegram (see `stripRemoteEcho`). It recognises the line by comparing it with the forwarded message.
 */
function normalizeEcho(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^[>\s"'“”„‘’«»]+/, "")
    .replace(/[\s"'“”„‘’«»]+$/, "")
    .replace(/(…|\.\.\.)$/, "")
    .trim();
}

/**
 * Remove the echo line when it is the FIRST line of a text: the line repeats (a shortened start of) one of the
 * forwarded `messages`, with no label. Other text stays unchanged. Only the first line is checked.
 */
export function stripRemoteEcho(text: string, messages: readonly string[]): string {
  if (messages.length === 0) return text;
  const lines = text.split("\n");
  const first = normalizeEcho(lines[0]!);
  if (first.length < 2) return text;
  if (!messages.some((m) => normalizeEcho(m).startsWith(first))) return text;
  return lines.slice(1).join("\n").replace(/^\s+/, "");
}

/** Environment variable. When set to `off`, the remote hook exits 0 at once (used for PA's own Agent SDK turns). */
export const REMOTE_HOOKS_DISABLE_ENV = "PA_REMOTE_HOOKS";

/** Hook events the bridge understands (other events are ignored). */
export const REMOTE_HOOK_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "MessageDisplay",
  "Stop",
  "StopFailure",
  "Notification",
  "SessionEnd",
] as const;

export type RemoteHookEvent = (typeof REMOTE_HOOK_EVENTS)[number];

/** Max length of the session working directory and name kept by the daemon. */
export const REMOTE_MAX_CWD_CHARS = 300;
export const REMOTE_MAX_NAME_CHARS = 80;

export interface RemoteQueuedMessage {
  /** Bridge-wide increasing id, shown to the model as `id N`. */
  msgId: number;
  text: string;
}

/** Body of `200` answer of `GET /remote/poll`. */
export interface RemotePollResponse {
  messages: RemoteQueuedMessage[];
}

export type RemoteControlAction = "attach" | "detach" | "status";

/** Body of `POST /remote/control`. */
export interface RemoteControlRequest {
  action: RemoteControlAction;
  /** Telegram chat id. Default: first id of `adapters.telegram.allowedUserIds`. */
  chatId?: string;
  /** Session index (from status) or name. */
  target?: string;
}

export interface RemoteSessionInfo {
  /** Stable session number (grows with each registration, never reused). Used by `/attach <n>`. */
  index: number;
  name: string;
  cwd: string;
  pid: number;
  attachedChatId?: string;
}

/** Body of the `200` answer of `POST /remote/control`. */
export interface RemoteControlResponse {
  ok: boolean;
  message: string;
  sessions: RemoteSessionInfo[];
}

export type RemotePollResult =
  | { kind: "messages"; messages: RemoteQueuedMessage[] }
  | { kind: "timeout" }
  | { kind: "replaced" };

/** Contract between the HTTP routes / Telegram router and the bridge implementation (`src/remote/bridge.ts`). */
export interface RemoteBridge {
  /**
   * Long poll for one session (registers the session on first call). Resolves with queued messages when the session is
   * attached and has messages, `timeout` after REMOTE_POLL_TIMEOUT_MS, `replaced` when a newer poll for the same pid
   * arrives, or `timeout` when `signal` aborts (client went away).
   */
  poll(args: { pid: number; cwd: string; name: string; signal: AbortSignal }): Promise<RemotePollResult>;
  /** Handle one hook event. Never throws on unknown payload shapes. */
  handleHook(event: string, pid: number, payload: unknown, cwd?: string): Promise<void>;
  /** Forward one Telegram text to the session attached to `chatId`. */
  forward(chatId: string, text: string): ForwardResult;
  /** Control operations (Telegram commands, MCP tools, CLI). */
  control(request: RemoteControlRequest): Promise<RemoteControlResponse>;
  /** True when `chatId` has an attached session. */
  isAttached(chatId: string): boolean;
  /** Stop timers and pending polls. */
  stop(): void;
}

export type ForwardResult = { accepted: true; msgId: number } | { accepted: false; reason: string };
