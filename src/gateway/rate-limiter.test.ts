import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config } from "../core/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../core/logger.js", () => ({
  createLogger: () => mockLog,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createRateLimiter } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: {
  enabled?: boolean;
  windowMs?: number;
  maxRequests?: number;
} = {}): Config {
  return {
    security: {
      allowedCommands: [],
      commandsNeedingExtraValidation: [],
      allowSudo: false,
      workspace: "/tmp/workspace",
      dataDir: "/tmp/data",
      additionalReadDirs: [],
      additionalWriteDirs: [],
    },
    adapters: {
      telegram: { enabled: false, botToken: "", allowedUserIds: [], mode: "polling" as const },
      slack: { enabled: false, botToken: "", appToken: "", socketMode: false, allowedUserIds: [] },
    },
    heartbeat: { enabled: false, intervalMinutes: 60, activeHours: "8-21", deliverTo: "last" as const },
    gateway: {
      maxQueueSize: 20,
      processingUpdateIntervalMs: 5000,
      rateLimiter: {
        enabled: overrides.enabled ?? true,
        windowMs: overrides.windowMs ?? 60_000,
        maxRequests: overrides.maxRequests ?? 5,
      },
    },
    agent: { backend: "claude" as const, model: null, maxTurns: 10 },
    session: { maxHistoryMessages: 50, compactionEnabled: false },
    memory: {
      search: {
        enabled: false,
        hybridWeights: { vector: 0.7, keyword: 0.3 },
        minScore: 0.3,
        maxResults: 10,
        chunkTokens: 512,
        chunkOverlap: 64,
      },
      extraPaths: [],
    },
    mcpServers: {},
    codex: {
      codexPath: null,
      apiKey: null,
      baseUrl: null,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccess: false,
      reasoningEffort: null,
      skipGitRepoCheck: true,
      configOverrides: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("when disabled", () => {
    it("always allows requests regardless of volume", () => {
      const limiter = createRateLimiter(makeConfig({ enabled: false, maxRequests: 2 }));

      for (let i = 0; i < 10; i++) {
        expect(limiter.check("user1")).toEqual({ allowed: true });
      }
    });
  });

  describe("when enabled", () => {
    it("allows requests up to maxRequests within the window", () => {
      const limiter = createRateLimiter(makeConfig({ maxRequests: 3 }));

      expect(limiter.check("user1")).toEqual({ allowed: true });
      expect(limiter.check("user1")).toEqual({ allowed: true });
      expect(limiter.check("user1")).toEqual({ allowed: true });
    });

    it("rejects the request that exceeds maxRequests", () => {
      const limiter = createRateLimiter(makeConfig({ maxRequests: 3 }));

      limiter.check("user1");
      limiter.check("user1");
      limiter.check("user1");

      const result = limiter.check("user1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("tracks users independently", () => {
      const limiter = createRateLimiter(makeConfig({ maxRequests: 2 }));

      limiter.check("userA");
      limiter.check("userA");
      expect(limiter.check("userA").allowed).toBe(false);

      // userB is unaffected
      expect(limiter.check("userB")).toEqual({ allowed: true });
      expect(limiter.check("userB")).toEqual({ allowed: true });
      expect(limiter.check("userB").allowed).toBe(false);
    });

    it("allows requests again after the window expires", () => {
      const windowMs = 10_000;
      const limiter = createRateLimiter(makeConfig({ maxRequests: 2, windowMs }));

      limiter.check("user1");
      limiter.check("user1");
      expect(limiter.check("user1").allowed).toBe(false);

      // Advance time past the window
      vi.advanceTimersByTime(windowMs + 1);

      // Should be allowed again
      expect(limiter.check("user1")).toEqual({ allowed: true });
    });

    it("slides the window correctly (only counts recent requests)", () => {
      const windowMs = 10_000;
      const limiter = createRateLimiter(makeConfig({ maxRequests: 3, windowMs }));

      // Make 2 requests at t=0
      limiter.check("user1");
      limiter.check("user1");

      // Advance halfway
      vi.advanceTimersByTime(5_000);

      // Make 1 more at t=5000 (total: 3, should be allowed)
      expect(limiter.check("user1")).toEqual({ allowed: true });

      // 4th request at t=5000 should be rejected (3 in window)
      expect(limiter.check("user1").allowed).toBe(false);

      // Advance past the first 2 timestamps (t > windowMs = 10001ms from start)
      vi.advanceTimersByTime(5_001);

      // Now only the t=5000 request is in the window → 2 slots free
      expect(limiter.check("user1")).toEqual({ allowed: true });
      expect(limiter.check("user1")).toEqual({ allowed: true });
    });

    it("returns a positive retryAfterMs when rejected", () => {
      const windowMs = 30_000;
      const limiter = createRateLimiter(makeConfig({ maxRequests: 1, windowMs }));

      limiter.check("user1"); // consumed
      vi.advanceTimersByTime(5_000); // 5 seconds later

      const result = limiter.check("user1");
      expect(result.allowed).toBe(false);
      // oldest request was at t=0; window expires at t=30000; now is t=5000
      // retryAfterMs should be ~25000
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(windowMs);
    });

    it("logs a warning when rate limit is exceeded", () => {
      const limiter = createRateLimiter(makeConfig({ maxRequests: 1 }));
      limiter.check("user1");
      limiter.check("user1");

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: "user1" }),
        "rate limit exceeded",
      );
    });
  });

  describe("count()", () => {
    it("returns 0 for a new user", () => {
      const limiter = createRateLimiter(makeConfig());
      expect(limiter.count("user1")).toBe(0);
    });

    it("returns the number of requests in the current window", () => {
      const limiter = createRateLimiter(makeConfig({ maxRequests: 10 }));
      limiter.check("user1");
      limiter.check("user1");
      limiter.check("user1");
      expect(limiter.count("user1")).toBe(3);
    });

    it("excludes expired timestamps from the count", () => {
      const windowMs = 10_000;
      const limiter = createRateLimiter(makeConfig({ maxRequests: 10, windowMs }));
      limiter.check("user1");
      limiter.check("user1");

      vi.advanceTimersByTime(windowMs + 1);
      expect(limiter.count("user1")).toBe(0);
    });
  });

  describe("reset()", () => {
    it("clears the user's request history so they can send again", () => {
      const limiter = createRateLimiter(makeConfig({ maxRequests: 2 }));
      limiter.check("user1");
      limiter.check("user1");
      expect(limiter.check("user1").allowed).toBe(false);

      limiter.reset("user1");

      expect(limiter.check("user1")).toEqual({ allowed: true });
    });

    it("does not affect other users", () => {
      const limiter = createRateLimiter(makeConfig({ maxRequests: 1 }));
      limiter.check("user1");
      limiter.check("user2");

      limiter.reset("user1");

      expect(limiter.check("user1")).toEqual({ allowed: true });
      expect(limiter.check("user2").allowed).toBe(false);
    });
  });
});
