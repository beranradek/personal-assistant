/**
 * Integ-API Integration Registry
 * ================================
 *
 * Central registry for all integration modules. Provides:
 * - Module registration and lookup
 * - GET /integ-api/integrations discovery endpoint
 *
 * Modules implement IntegrationModule from types.ts and self-register their routes.
 */

import { createLogger } from "../../core/logger.js";
import type { IntegrationModule, IntegrationManifest } from "../types.js";
import type { SimpleRouter } from "../server.js";

const log = createLogger("integ-api:registry");

// ---------------------------------------------------------------------------
// IntegrationRegistry interface
// ---------------------------------------------------------------------------

export interface IntegrationRegistry {
  /** Register a module and mount its routes on the router. */
  register(module: IntegrationModule, router: SimpleRouter): void;
  /** Look up a module by its id. */
  getModule(id: string): IntegrationModule | undefined;
  /** Return all registered manifests (for discovery endpoint). */
  getAllManifests(): IntegrationManifest[];
}

// ---------------------------------------------------------------------------
// createRegistry
// ---------------------------------------------------------------------------

/**
 * Create an integration registry and mount the discovery endpoint on `router`.
 *
 * @param router - The SimpleRouter to register the discovery endpoint on.
 */
export function createRegistry(router: SimpleRouter): IntegrationRegistry {
  const modules = new Map<string, IntegrationModule>();

  // Register discovery endpoint
  // GET /integ-api/integrations → { integrations: IntegrationManifest[] }
  router.get("/integ-api/integrations", async (_req, res) => {
    const integrations = registry.getAllManifests();
    res.json({ integrations });
  });

  const registry: IntegrationRegistry = {
    register(module: IntegrationModule, moduleRouter: SimpleRouter): void {
      if (modules.has(module.id)) {
        log.warn({ id: module.id }, "Integration module already registered, overwriting");
      }
      modules.set(module.id, module);
      module.routes(moduleRouter);
      log.info({ id: module.id, endpoints: module.manifest.endpoints.length }, "Integration module registered");
    },

    getModule(id: string): IntegrationModule | undefined {
      return modules.get(id);
    },

    getAllManifests(): IntegrationManifest[] {
      return [...modules.values()].map((m) => m.manifest);
    },
  };

  return registry;
}
