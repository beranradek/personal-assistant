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
import type { AgentOptions, AgentTurnResult, StreamEvent } from "../core/agent-runner.js";
import type { Router } from "./router.js";
import { runAgentTurn, streamAgentTurn, clearSdkSession } from "../core/agent-runner.js";
import { resolveSessionKey } from "../session/manager.js";
import { createLogger } from "../core/logger.js";
import { isHeartbeatOk } from "../heartbeat/prompts.js";
import { createProcessingAccumulator } from "./processing-message.js";

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

  // Track last adapter interaction for heartbeat response routing.
  // When a heartbeat fires, the response needs to be delivered to an actual
  // adapter (telegram/slack) based on config.heartbeat.deliverTo.
  const lastSourceByAdapter = new Map<string, string>();
  let lastAdapterName: string | null = null;

  function resolveRouteTarget(
    message: AdapterMessage,
    cfg: Config,
  ): { source: string; sourceId: string } | null {
    if (message.source !== "heartbeat") {
      return { source: message.source, sourceId: message.sourceId };
    }
    const { deliverTo } = cfg.heartbeat;
    const targetAdapter = deliverTo === "last" ? lastAdapterName : deliverTo;
    if (!targetAdapter) return null;
    const targetSourceId = lastSourceByAdapter.get(targetAdapter);
    if (!targetSourceId) return null;
    return { source: targetAdapter, sourceId: targetSourceId };
  }

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

      // Track adapter interactions for heartbeat routing
      if (message.source !== "heartbeat") {
        lastAdapterName = message.source;
        lastSourceByAdapter.set(message.source, message.sourceId);
      }

      const sessionKey = resolveSessionKey(message.source, message.sourceId);
      log.info(
        { source: message.source, sessionKey },
        "processing message",
      );

      // Handle /clear command — reset conversation history
      if (message.text.trim() === "/clear") {
        clearSdkSession(sessionKey);
        log.info({ sessionKey }, "session cleared via /clear");
        try {
          await router.route({
            source: message.source,
            sourceId: message.sourceId,
            text: "Conversation cleared. Starting fresh.",
            metadata: message.metadata,
          });
        } catch (routeErr) {
          log.error({ err: routeErr }, "failed to send /clear confirmation");
        }
        return true;
      }

      try {
        const routeTarget = resolveRouteTarget(message, config);
        const targetAdapter = routeTarget
          ? router.getAdapter(routeTarget.source)
          : undefined;
        const supportsProcessing =
          message.source !== "heartbeat" &&
          targetAdapter?.createProcessingMessage != null &&
          targetAdapter?.updateProcessingMessage != null;

        let responseText: string;
        let partial = false;

        if (supportsProcessing && routeTarget) {
          // Streaming path with processing message
          const accumulator = createProcessingAccumulator(
            targetAdapter as {
              createProcessingMessage: NonNullable<typeof targetAdapter.createProcessingMessage>;
              updateProcessingMessage: NonNullable<typeof targetAdapter.updateProcessingMessage>;
            },
            routeTarget.sourceId,
            message.metadata,
            config.gateway.processingUpdateIntervalMs,
          );
          accumulator.start();

          let resultEvent:
            | { response: string; messages: unknown[]; partial: boolean }
            | undefined;

          // Track text after the last tool call — this is the final response
          // to send as a new message. result.response contains ALL text across
          // every turn (including intermediate text already shown in the
          // processing message), so we only want the tail portion.
          let finalText = "";
          let sawTool = false;

          for await (const event of streamAgentTurn(
            message.text,
            sessionKey,
            agentOptions,
            config,
          )) {
            accumulator.handleEvent(event);
            if (event.type === "tool_start") {
              finalText = "";
              sawTool = true;
            }
            if (event.type === "text_delta") {
              finalText += event.text;
            }
            if (event.type === "result") {
              resultEvent = event;
            }
            if (event.type === "error") {
              resultEvent = { response: event.error, messages: [], partial: true };
            }
          }

          await accumulator.stop();

          // If tools were used and there is text after the last tool call,
          // send only that tail text (the rest was already shown in the
          // processing message). Otherwise fall back to the full response.
          responseText =
            sawTool && finalText.trim()
              ? finalText
              : (resultEvent?.response ?? "");
          partial = resultEvent?.partial ?? false;
        } else {
          // Non-streaming fallback
          const result: AgentTurnResult = await runAgentTurn(
            message.text,
            sessionKey,
            agentOptions,
            config,
          );
          responseText = result.response;
          partial = result.partial;
        }

        // Build the response text, appending a notice if the response is partial
        if (partial) {
          responseText +=
            "\n\n[Note: This response may be incomplete due to an internal interruption.]";
        }

        // Route the response back to the source adapter
        if (responseText.trim()) {
          // Suppress heartbeat responses that contain HEARTBEAT_OK
          if (message.source === "heartbeat" && isHeartbeatOk(responseText)) {
            log.debug({ sessionKey }, "heartbeat OK, no notification needed");
          } else if (routeTarget) {
            const response: AdapterMessage = {
              source: routeTarget.source,
              sourceId: routeTarget.sourceId,
              text: responseText,
              metadata: message.metadata,
            };
            await router.route(response);
          } else {
            log.warn(
              { deliverTo: config.heartbeat.deliverTo },
              "no adapter target for heartbeat, dropping response",
            );
          }
        } else {
          // Notify the user when the agent returns an empty response
          log.warn(
            { source: message.source, sessionKey },
            "agent returned empty response",
          );
          const emptyTarget = resolveRouteTarget(message, config);
          if (emptyTarget) {
            try {
              await router.route({
                source: emptyTarget.source,
                sourceId: emptyTarget.sourceId,
                text: "I processed your message but had nothing to respond with. Could you try rephrasing?",
                metadata: message.metadata,
              });
            } catch (routeErr) {
              log.error(
                { err: routeErr },
                "failed to send empty-response notice",
              );
            }
          }
        }
      } catch (err) {
        log.error({ err, source: message.source }, "failed to process message");

        // Notify the user that something went wrong
        const errorTarget = resolveRouteTarget(message, config);
        if (errorTarget) {
          try {
            const errorResponse: AdapterMessage = {
              source: errorTarget.source,
              sourceId: errorTarget.sourceId,
              text: "Sorry, something went wrong while processing your message. Please try again.",
              metadata: message.metadata,
            };
            await router.route(errorResponse);
          } catch (routeErr) {
            log.error({ err: routeErr }, "failed to send error response");
          }
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
