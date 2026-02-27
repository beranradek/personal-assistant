/**
 * Response Router
 * ===============
 *
 * Maintains a registry of adapters and routes agent responses back to
 * the originating adapter based on the message's `source` field.
 */

import type { Adapter, AdapterMessage } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("gateway-router");

export interface Router {
  /** Register an adapter so it can receive routed responses. */
  register(adapter: Adapter): void;
  /** Remove an adapter from the registry. */
  unregister(name: string): void;
  /** Look up a registered adapter by name. */
  getAdapter(name: string): Adapter | undefined;
  /** Route a response message to its source adapter. */
  route(response: AdapterMessage): Promise<void>;
}

/**
 * Create a new response router.
 *
 * The router maintains a map of adapter name to adapter instance.
 * When `route(response)` is called, it looks up the adapter matching
 * `response.source` and calls `sendResponse()` on it.
 *
 * If the adapter is not found, a warning is logged and the message is dropped.
 */
export function createRouter(): Router {
  const adapters = new Map<string, Adapter>();

  return {
    register(adapter: Adapter): void {
      adapters.set(adapter.name, adapter);
      log.info({ adapter: adapter.name }, "adapter registered");
    },

    unregister(name: string): void {
      adapters.delete(name);
      log.info({ adapter: name }, "adapter unregistered");
    },

    getAdapter(name: string): Adapter | undefined {
      return adapters.get(name);
    },

    async route(response: AdapterMessage): Promise<void> {
      const adapter = adapters.get(response.source);
      if (!adapter) {
        log.warn(
          { source: response.source },
          "no adapter registered for source, dropping response",
        );
        return;
      }
      await adapter.sendResponse(response);
    },
  };
}
