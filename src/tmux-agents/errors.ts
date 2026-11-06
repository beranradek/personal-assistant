/** Error codes returned by the `agent_session_*` tools. */
export const ERROR_CODES = [
  "DISABLED",
  "INVALID_INPUT",
  "ROOT_NOT_ALLOWED",
  "TOO_MANY_SESSIONS",
  "RATE_LIMITED",
  "NOT_FOUND",
  "NOT_OWNED",
  "BUSY",
  "WAITING_PERMISSION",
  "WAITING_TRUST",
  "BYPASS_NOT_ALLOWED",
  "ROOT_NOT_TRUSTED",
  "TMUX_ERROR",
  "TIMEOUT",
] as const;

export type TmuxAgentErrorCode = (typeof ERROR_CODES)[number];

/** Expected failure of a tmux agent operation. The tool layer maps it to `{ ok: false, error }`. */
export class TmuxAgentError extends Error {
  constructor(
    readonly code: TmuxAgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TmuxAgentError";
  }
}
