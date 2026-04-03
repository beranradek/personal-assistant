/**
 * Tests for IntegrationRegistry
 *
 * GWT verification:
 * 1. Given gmail module is registered, When GET /integ-api/integrations is called, Then gmail appears in response
 * 2. Registry returns correct manifests for all registered modules
 * 3. getModule returns the correct module by id
 * 4. Registering duplicate module id overwrites previous
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { SimpleRouter, createIntegApiServer } from "../server.js";
import { createRegistry } from "./registry.js";
import type { IntegrationModule, IntegrationManifest } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function request(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let portCounter = 19400;
function nextPort(): number {
  return portCounter++;
}

function makeTestModule(id: string, capabilities: string[] = ["read"]): IntegrationModule {
  const manifest: IntegrationManifest = {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    status: "active",
    capabilities,
    endpoints: [{ method: "GET", path: `/${id}/test` }],
    rateLimits: { requestsPerMinute: 60 },
  };
  return {
    id,
    manifest,
    routes(_router: SimpleRouter): void {
      // no-op for test
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IntegrationRegistry", () => {
  it("returns empty integrations list when no modules registered", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    createRegistry(server.router);
    await server.start();
    try {
      const res = await request(port, "GET", "/integ-api/integrations");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ integrations: [] });
    } finally {
      await server.stop();
    }
  });

  it("GWT: registered gmail module appears in discovery endpoint with correct capabilities", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const registry = createRegistry(server.router);
    const gmailModule = makeTestModule("gmail", ["list", "read", "search", "labels"]);
    registry.register(gmailModule, server.router);
    await server.start();
    try {
      const res = await request(port, "GET", "/integ-api/integrations");
      expect(res.status).toBe(200);
      const body = res.body as { integrations: IntegrationManifest[] };
      expect(body.integrations).toHaveLength(1);
      expect(body.integrations[0]?.id).toBe("gmail");
      expect(body.integrations[0]?.capabilities).toEqual(["list", "read", "search", "labels"]);
    } finally {
      await server.stop();
    }
  });

  it("returns all registered modules in discovery endpoint", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const registry = createRegistry(server.router);
    registry.register(makeTestModule("gmail"), server.router);
    registry.register(makeTestModule("calendar"), server.router);
    await server.start();
    try {
      const res = await request(port, "GET", "/integ-api/integrations");
      const body = res.body as { integrations: IntegrationManifest[] };
      expect(body.integrations).toHaveLength(2);
      const ids = body.integrations.map((m) => m.id);
      expect(ids).toContain("gmail");
      expect(ids).toContain("calendar");
    } finally {
      await server.stop();
    }
  });

  it("getModule returns undefined for unknown id", () => {
    const router = new SimpleRouter();
    const registry = createRegistry(router);
    expect(registry.getModule("nonexistent")).toBeUndefined();
  });

  it("getModule returns the correct module", () => {
    const router = new SimpleRouter();
    const registry = createRegistry(router);
    const mod = makeTestModule("gmail");
    registry.register(mod, router);
    expect(registry.getModule("gmail")).toBe(mod);
  });

  it("getAllManifests returns all registered manifests", () => {
    const router = new SimpleRouter();
    const registry = createRegistry(router);
    registry.register(makeTestModule("gmail"), router);
    registry.register(makeTestModule("calendar"), router);
    const manifests = registry.getAllManifests();
    expect(manifests).toHaveLength(2);
    expect(manifests.map((m) => m.id)).toContain("gmail");
    expect(manifests.map((m) => m.id)).toContain("calendar");
  });

  it("registering duplicate id overwrites previous module", () => {
    const router = new SimpleRouter();
    const registry = createRegistry(router);
    const mod1 = makeTestModule("gmail", ["read"]);
    const mod2 = makeTestModule("gmail", ["read", "write"]);
    registry.register(mod1, router);
    registry.register(mod2, router);
    expect(registry.getModule("gmail")).toBe(mod2);
    expect(registry.getAllManifests()).toHaveLength(1);
    expect(registry.getAllManifests()[0]?.capabilities).toEqual(["read", "write"]);
  });
});
