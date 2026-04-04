/**
 * Integ-API Integration Registry
 * ================================
 *
 * Central registry for all integration modules.
 * Provides module registration, lookup by ID, and the
 * GET /integ-api/integrations discovery endpoint.
 *
 * Usage:
 *   const registry = createRegistry(router);
 *   registry.register(calendarModule);
 *   registry.register(gmailModule);
 */

import { createLogger } from "../../core/logger.js";
import type { SimpleRouter } from "../server.js";
import type { IntegrationModule, IntegrationManifest } from "../types.js";

const log = createLogger("integ-api:registry");

// ---------------------------------------------------------------------------
// IntegrationRegistry interface
// ---------------------------------------------------------------------------

export interface IntegrationRegistry {
  /** Register an integration module and mount its routes. */
  register(module: IntegrationModule): void;

  /** Look up a registered module by its ID. Returns undefined if not found. */
  getModule(id: string): IntegrationModule | undefined;

  /** Return manifests for all registered integrations. */
  getAllManifests(): IntegrationManifest[];
}

// ---------------------------------------------------------------------------
// createRegistry
// ---------------------------------------------------------------------------

/**
 * Create an integration registry and wire the discovery endpoint.
 *
 * @param router - The SimpleRouter to register routes on.
 */
export function createRegistry(router: SimpleRouter): IntegrationRegistry {
  const modules = new Map<string, IntegrationModule>();

  // Discovery endpoint: GET /integ-api/integrations
  router.get("/integ-api/integrations", async (_req, res) => {
    const integrations = [...modules.values()].map((m) => m.manifest);
    res.json({ integrations });
  });

  const registry: IntegrationRegistry = {
    register(module: IntegrationModule): void {
      if (modules.has(module.id)) {
        log.warn({ id: module.id }, "Integration module already registered — overwriting");
      }
      modules.set(module.id, module);
      module.routes(router);
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
