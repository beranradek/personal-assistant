/**
 * Processing Message Accumulator
 * ==============================
 *
 * Consumes StreamEvent objects from streamAgentTurn() and periodically
 * flushes formatted intermediate output to an adapter's processing message.
 *
 * The accumulator creates a single message on first flush, then updates it
 * on subsequent flushes. Text deltas and tool calls are interleaved in the
 * output, matching the terminal streaming display style.
 */

import type { StreamEvent } from "../core/agent-runner.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("processing-message");

/** Max content length before truncation (conservative for both platforms). */
const MAX_CONTENT_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Tool input formatting (mirrors terminal/stream-render.ts)
// ---------------------------------------------------------------------------

export function formatToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const MAX_CMD_LEN = 60;

  switch (toolName) {
    case "Bash": {
      const cmd = input.command as string | undefined;
      if (!cmd) return toolName;
      const truncated =
        cmd.length > MAX_CMD_LEN ? cmd.slice(0, MAX_CMD_LEN) + "..." : cmd;
      return `Running: ${truncated}`;
    }
    case "Read": {
      const fp = input.file_path as string | undefined;
      return fp ? `Reading ${fp}` : toolName;
    }
    case "Write": {
      const fp = input.file_path as string | undefined;
      return fp ? `Writing ${fp}` : toolName;
    }
    case "Edit": {
      const fp = input.file_path as string | undefined;
      return fp ? `Editing ${fp}` : toolName;
    }
    case "Glob": {
      const pat = input.pattern as string | undefined;
      return pat ? `Searching: ${pat}` : toolName;
    }
    case "Grep": {
      const pat = input.pattern as string | undefined;
      return pat ? `Grepping: ${pat}` : toolName;
    }
    case "WebFetch": {
      const url = input.url as string | undefined;
      return url ? `Fetching: ${url}` : toolName;
    }
    case "WebSearch": {
      const q = input.query as string | undefined;
      return q ? `Searching web: ${q}` : toolName;
    }
    default:
      return toolName;
  }
}

// ---------------------------------------------------------------------------
// Accumulator types
// ---------------------------------------------------------------------------

interface AdapterProcessingMethods {
  createProcessingMessage(
    sourceId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<string>;
  updateProcessingMessage(
    sourceId: string,
    messageId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

export interface ProcessingMessageAccumulator {
  /** Feed a stream event into the accumulator. */
  handleEvent(event: StreamEvent): void;
  /** Start the periodic flush timer. */
  start(): void;
  /** Stop timer and do a final flush if needed. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ProcessingMessageAccumulator that buffers StreamEvents and
 * periodically flushes them to an adapter's processing message.
 */
export function createProcessingAccumulator(
  adapter: AdapterProcessingMethods,
  sourceId: string,
  metadata: Record<string, unknown> | undefined,
  intervalMs: number,
): ProcessingMessageAccumulator {
  let flushedContent = "";
  const buffer: string[] = [];
  let messageId: string | null = null;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let lastElapsedSeconds = 0;
  let currentToolName: string | null = null;
  let flushing = false;

  function truncateContent(content: string): string {
    if (content.length <= MAX_CONTENT_LENGTH) return content;
    const truncated = content.slice(content.length - MAX_CONTENT_LENGTH + 40);
    const firstNewline = truncated.indexOf("\n");
    const cleanStart =
      firstNewline !== -1 ? truncated.slice(firstNewline + 1) : truncated;
    return `[...earlier output truncated...]\n${cleanStart}`;
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    if (buffer.length === 0 && lastElapsedSeconds === 0) return;

    flushing = true;
    try {
      const newContent = buffer.join("");
      buffer.length = 0;

      flushedContent += newContent;

      let displayContent = flushedContent;
      if (lastElapsedSeconds > 0) {
        displayContent += `\n\n\u23f3 Processing... (${lastElapsedSeconds}s)`;
      }

      displayContent = truncateContent(displayContent);

      if (!messageId) {
        messageId = await adapter.createProcessingMessage(
          sourceId,
          displayContent,
          metadata,
        );
        log.debug({ messageId, sourceId }, "created processing message");
      } else {
        await adapter.updateProcessingMessage(
          sourceId,
          messageId,
          displayContent,
          metadata,
        );
        log.debug({ messageId, sourceId }, "updated processing message");
      }
    } catch (err) {
      log.error(
        { err, sourceId, messageId },
        "failed to flush processing message",
      );
    } finally {
      flushing = false;
    }
  }

  return {
    handleEvent(event: StreamEvent): void {
      switch (event.type) {
        case "tool_start":
          currentToolName = event.toolName;
          buffer.push(`\n\ud83d\udd27 ${event.toolName}`);
          break;
        case "tool_input":
          if (currentToolName === event.toolName) {
            const lastIdx = buffer.length - 1;
            if (lastIdx >= 0 && buffer[lastIdx].includes(event.toolName)) {
              buffer[lastIdx] = `\n\ud83d\udd27 ${formatToolInput(event.toolName, event.input)}`;
            }
          }
          break;
        case "text_delta":
          buffer.push(event.text);
          break;
        case "tool_progress":
          lastElapsedSeconds = event.elapsedSeconds;
          break;
        case "result":
        case "error":
          break;
      }
    },

    start(): void {
      intervalHandle = setInterval(() => {
        void flush();
      }, intervalMs);
    },

    async stop(): Promise<void> {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      await flush();
    },
  };
}
