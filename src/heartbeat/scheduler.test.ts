import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node-cron before importing the module under test
let scheduledCallback: (() => void) | null = null;
const mockStop = vi.fn();

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((_expression: string, fn: () => void) => {
      scheduledCallback = fn;
      return { stop: mockStop };
    }),
  },
}));

// Mock the logger so it doesn't produce output during tests
vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  parseActiveHours,
  isWithinActiveHours,
  createHeartbeatScheduler,
} from "./scheduler.js";
import type { Config } from "../core/types.js";

function makeConfig(overrides: Partial<Config["heartbeat"]> = {}): Config {
  return {
    heartbeat: {
      enabled: true,
      intervalMinutes: 15,
      activeHours: "8-21",
      deliverTo: "last",
      ...overrides,
    },
  } as Config;
}

describe("heartbeat scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    scheduledCallback = null;
    mockStop.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // parseActiveHours
  // ---------------------------------------------------------------------------
  describe("parseActiveHours", () => {
    it("parses '8-21' into { start: 8, end: 21 }", () => {
      expect(parseActiveHours("8-21")).toEqual({ start: 8, end: 21 });
    });

    it("parses '0-24' into { start: 0, end: 24 }", () => {
      expect(parseActiveHours("0-24")).toEqual({ start: 0, end: 24 });
    });

    it("parses '9-17' into { start: 9, end: 17 }", () => {
      expect(parseActiveHours("9-17")).toEqual({ start: 9, end: 17 });
    });
  });

  // ---------------------------------------------------------------------------
  // isWithinActiveHours
  // ---------------------------------------------------------------------------
  describe("isWithinActiveHours", () => {
    it("returns true when current hour is within range", () => {
      // hour = 12, within 8-21
      const noon = new Date(2026, 0, 15, 12, 0, 0);
      expect(isWithinActiveHours("8-21", noon)).toBe(true);
    });

    it("returns true at the start boundary (inclusive)", () => {
      const start = new Date(2026, 0, 15, 8, 0, 0);
      expect(isWithinActiveHours("8-21", start)).toBe(true);
    });

    it("returns false at the end boundary (exclusive)", () => {
      const end = new Date(2026, 0, 15, 21, 0, 0);
      expect(isWithinActiveHours("8-21", end)).toBe(false);
    });

    it("returns false when before active hours", () => {
      const early = new Date(2026, 0, 15, 5, 0, 0);
      expect(isWithinActiveHours("8-21", early)).toBe(false);
    });

    it("returns false when after active hours", () => {
      const late = new Date(2026, 0, 15, 23, 0, 0);
      expect(isWithinActiveHours("8-21", late)).toBe(false);
    });

    it("uses current time when no date is provided", () => {
      // Set fake time to 10:00 (within 8-21)
      vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
      expect(isWithinActiveHours("8-21")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // createHeartbeatScheduler
  // ---------------------------------------------------------------------------
  describe("createHeartbeatScheduler", () => {
    it("starts a cron timer when heartbeat is enabled", async () => {
      const cron = await import("node-cron");
      const callback = vi.fn();
      const config = makeConfig();

      createHeartbeatScheduler(config, callback);

      expect(cron.default.schedule).toHaveBeenCalledWith(
        "*/15 * * * *",
        expect.any(Function),
      );
    });

    it("returns a no-op when heartbeat is disabled", async () => {
      const callback = vi.fn();
      const config = makeConfig({ enabled: false });

      const scheduler = createHeartbeatScheduler(config, callback);
      scheduler.stop(); // should not throw
      expect(scheduledCallback).toBeNull();
    });

    it("stop() cancels the timer", () => {
      const callback = vi.fn();
      const config = makeConfig();

      const scheduler = createHeartbeatScheduler(config, callback);
      scheduler.stop();

      expect(mockStop).toHaveBeenCalled();
    });

    it("calls onHeartbeat callback when firing within active hours", () => {
      // Set time to noon (within 8-21)
      vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));

      const callback = vi.fn();
      const config = makeConfig();

      createHeartbeatScheduler(config, callback);

      // Simulate cron firing
      expect(scheduledCallback).not.toBeNull();
      scheduledCallback!();

      expect(callback).toHaveBeenCalledOnce();
    });

    it("skips onHeartbeat when outside active hours", () => {
      // Set time to 3 AM (outside 8-21)
      vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));

      const callback = vi.fn();
      const config = makeConfig();

      createHeartbeatScheduler(config, callback);

      // Simulate cron firing
      expect(scheduledCallback).not.toBeNull();
      scheduledCallback!();

      expect(callback).not.toHaveBeenCalled();
    });

    it("handles async onHeartbeat callback errors gracefully", async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));

      const callback = vi.fn().mockRejectedValue(new Error("boom"));
      const config = makeConfig();

      createHeartbeatScheduler(config, callback);
      scheduledCallback!();

      // The error should be caught internally; no unhandled rejection
      // Flush microtasks
      await vi.advanceTimersByTimeAsync(0);

      expect(callback).toHaveBeenCalledOnce();
    });

    it("uses correct cron expression for custom interval", async () => {
      const cron = await import("node-cron");
      const callback = vi.fn();
      const config = makeConfig({ intervalMinutes: 30 });

      createHeartbeatScheduler(config, callback);

      expect(cron.default.schedule).toHaveBeenCalledWith(
        "*/30 * * * *",
        expect.any(Function),
      );
    });
  });
});
