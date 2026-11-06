/**
 * Zod shapes of the nine `agent_session_*` tools. Single source for the tool table (JSON schemas for stdio/HTTP,
 * SDK shapes) and for the input types of the service.
 */
import { z } from "zod";
import { PERMISSION_MODES } from "./kinds.js";
import { PROJECT_PATTERN, SESSION_PATTERN } from "./names.js";

const Project = z.string().regex(PROJECT_PATTERN);
const Session = z.string().regex(SESSION_PATTERN);
const KindId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/** Real maximum of `text` comes from `tmuxAgents.maxInputChars`; this is the hard upper bound. */
export const MAX_TEXT_CHARS = 20_000;

export const startShape = {
  project: Project.describe("Project label: a-z, 0-9, dashes, at most 32 characters"),
  directory: z.string().min(1).max(512).describe("Absolute path of the project directory (inside one of allowedRoots from agent_session_list)"),
  kind: KindId.default("claude").describe("Agent kind; only 'claude' is built in"),
  permissionMode: z.enum(PERMISSION_MODES).default("default").describe("'bypass' needs settings AND confirmBypass: ask the user first"),
  confirmBypass: z.literal(true).optional().describe("Only after the user confirmed bypass mode"),
};

export const listShape = {
  includeStopped: z.boolean().default(false).describe("Also list stopped and lost sessions"),
};

export const statusShape = { session: Session };

export const readShape = {
  session: Session,
  // No schema default: the service applies `tmuxAgents.defaultOutputLines`.
  lines: z.number().int().min(1).max(300).optional().describe("How many screen lines from the bottom (default from settings)"),
};

export const sendShape = {
  session: Session,
  text: z.string().min(1).max(MAX_TEXT_CHARS).describe("Message for the agent. Must not start with '!', '#' or '/'"),
  waitForIdleMs: z.number().int().min(0).max(300_000).default(0).describe("Wait up to this long for the agent to become idle"),
  queueWhileBusy: z.boolean().default(false).describe("Send even when the agent is busy"),
  answerPermissionPrompt: z.boolean().default(false).describe("Answer a permission prompt (needs settings allowAnswerPrompts)"),
  allowUnknownState: z.boolean().default(false).describe(
    "Send although the screen is not recognized (state unknown). Read the screen first; never use it to answer a dialog",
  ),
};

export const interruptShape = { session: Session };

export const stopShape = {
  session: Session,
  force: z.boolean().default(false).describe("Kill even when busy. Needs userConfirmed"),
  userConfirmed: z.literal(true).optional().describe("Only after the user confirmed a forced stop"),
};

export const recoverShape = {
  session: Session,
  userConfirmed: z.literal(true).describe("Only after the user confirmed: forced restart, unfinished work is lost"),
};

export const attachShape = {
  session: Session,
  readOnly: z.boolean().default(true).describe("Return the read-only attach command as the main command"),
};

type Output<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;

export type StartInput = Output<typeof startShape>;
export type ListInput = Output<typeof listShape>;
export type StatusInput = Output<typeof statusShape>;
export type ReadInput = Output<typeof readShape>;
export type SendInput = Output<typeof sendShape>;
export type InterruptInput = Output<typeof interruptShape>;
export type StopInput = Output<typeof stopShape>;
export type RecoverInput = Output<typeof recoverShape>;
export type AttachInput = Output<typeof attachShape>;
