/**
 * Gateway Message Queue
 * =====================
 *
 * Async FIFO queue with configurable max size. Adapters push AdapterMessage
 * objects into the queue via `enqueue()`. Messages are processed one at a time
 * through the agent runner via `processNext()`.
 *
 * The `processLoop()` method runs continuously, awaiting messages and
 * processing them serially.
 */

import type { AdapterMessage, Config } from "../core/types.js";
import type { AgentOptions, AgentTurnResult } from "../core/agent-runner.js";
import type { Router } from "./router.js";
import { runAgentTurn } from "../core/agent-runner.js";
import { resolveSessionKey } from "../session/manager.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("gateway-queue");

export type EnqueueResult =
  | { accepted: true }
  | { accepted: false; reason: string };

export interface MessageQueue {
  /** Add a message to the queue. Returns whether it was accepted. */
  enqueue(message: AdapterMessage): EnqueueResult;
  /** Process the next message in the queue. Returns true if a message was processed. */
  processNext(
    agentOptions: AgentOptions,
    config: Config,
    router: Router,
  ): Promise<boolean>;
  /** Current number of messages waiting in the queue. */
  size(): number;
  /**
   * Run a continuous processing loop. Resolves when `stop()` is called.
   * Awaits messages and processes them one at a time.
   */
  processLoop(
    agentOptions: AgentOptions,
    config: Config,
    router: Router,
  ): Promise<void>;
  /** Signal the process loop to stop after the current message completes. */
  stop(): void;
}

/**
 * Create a new message queue with the max size from config.
 */
export function createMessageQueue(config: Config): MessageQueue {
  const maxSize = config.gateway.maxQueueSize;
  const messages: AdapterMessage[] = [];
  let running = false;

  // For the continuous process loop: a resolver that is called when
  // a new message is enqueued (to wake up the loop).
  let wakeUp: (() => void) | null = null;

  return {
    enqueue(message: AdapterMessage): EnqueueResult {
      if (messages.length >= maxSize) {
        log.warn(
          { queueSize: messages.length, maxSize },
          "queue full, rejecting message",
        );
        return { accepted: false, reason: "Queue full" };
      }
      messages.push(message);
      log.debug(
        { source: message.source, queueSize: messages.length },
        "message enqueued",
      );
      // Wake up the process loop if it's waiting
      if (wakeUp) {
        wakeUp();
        wakeUp = null;
      }
      return { accepted: true };
    },

    /**
     * Process the next message in the queue.
     * Not safe for concurrent use — use `processLoop()` for serial processing.
     */
    async processNext(
      agentOptions: AgentOptions,
      config: Config,
      router: Router,
    ): Promise<boolean> {
      const message = messages.shift();
      if (!message) {
        return false;
      }

      const sessionKey = resolveSessionKey(message.source, message.sourceId);
      log.info(
        { source: message.source, sessionKey },
        "processing message",
      );

      try {
        const result: AgentTurnResult = await runAgentTurn(
          message.text,
          sessionKey,
          agentOptions,
          config,
        );

        // Route the response back to the source adapter
        const response: AdapterMessage = {
          source: message.source,
          sourceId: message.sourceId,
          text: result.response,
          metadata: message.metadata,
        };
        await router.route(response);
      } catch (err) {
        log.error({ err, source: message.source }, "failed to process message");

        // Notify the user that something went wrong
        try {
          const errorResponse: AdapterMessage = {
            source: message.source,
            sourceId: message.sourceId,
            text: "Sorry, something went wrong while processing your message. Please try again.",
            metadata: message.metadata,
          };
          await router.route(errorResponse);
        } catch (routeErr) {
          log.error({ err: routeErr }, "failed to send error response");
        }
      }

      return true;
    },

    size(): number {
      return messages.length;
    },

    async processLoop(
      agentOptions: AgentOptions,
      config: Config,
      router: Router,
    ): Promise<void> {
      running = true;
      log.info("process loop started");

      while (running) {
        if (messages.length === 0) {
          // Wait for a message to arrive
          await new Promise<void>((resolve) => {
            wakeUp = resolve;
          });
        }
        if (!running) break;

        await this.processNext(agentOptions, config, router);
      }

      log.info("process loop stopped");
    },

    stop(): void {
      running = false;
      // Wake up the loop so it can exit
      if (wakeUp) {
        wakeUp();
        wakeUp = null;
      }
    },
  };
}
