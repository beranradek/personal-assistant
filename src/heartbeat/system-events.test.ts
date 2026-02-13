import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  drainSystemEvents,
  clearSystemEvents,
} from "./system-events.js";

describe("system event queue", () => {
  beforeEach(() => {
    clearSystemEvents();
  });

  // -------------------------------------------------------------------------
  // enqueueSystemEvent
  // -------------------------------------------------------------------------
  describe("enqueueSystemEvent", () => {
    it("adds an event to the global queue", () => {
      enqueueSystemEvent("something happened");
      const events = peekSystemEvents();
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe("something happened");
    });

    it("defaults type to 'system'", () => {
      enqueueSystemEvent("default type");
      const [event] = peekSystemEvents();
      expect(event.type).toBe("system");
    });

    it("accepts an explicit type", () => {
      enqueueSystemEvent("cron fired", "cron");
      const [event] = peekSystemEvents();
      expect(event.type).toBe("cron");
    });

    it("accepts exec type", () => {
      enqueueSystemEvent("process exited", "exec");
      const [event] = peekSystemEvents();
      expect(event.type).toBe("exec");
    });
  });

  // -------------------------------------------------------------------------
  // Event fields
  // -------------------------------------------------------------------------
  describe("event fields", () => {
    it("has type, text, and timestamp fields", () => {
      enqueueSystemEvent("test event", "cron");
      const [event] = peekSystemEvents();

      expect(event).toHaveProperty("type", "cron");
      expect(event).toHaveProperty("text", "test event");
      expect(event).toHaveProperty("timestamp");
      expect(typeof event.timestamp).toBe("string");
    });

    it("timestamp is a valid ISO-8601 string", () => {
      enqueueSystemEvent("ts check");
      const [event] = peekSystemEvents();
      const parsed = new Date(event.timestamp);
      expect(parsed.toISOString()).toBe(event.timestamp);
    });
  });

  // -------------------------------------------------------------------------
  // peekSystemEvents
  // -------------------------------------------------------------------------
  describe("peekSystemEvents", () => {
    it("returns events without draining them", () => {
      enqueueSystemEvent("stay around");

      const first = peekSystemEvents();
      const second = peekSystemEvents();

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0].text).toBe("stay around");
      expect(second[0].text).toBe("stay around");
    });

    it("returns a copy (mutations do not affect queue)", () => {
      enqueueSystemEvent("immutable");
      const events = peekSystemEvents();
      events.length = 0; // mutate the returned array

      expect(peekSystemEvents()).toHaveLength(1);
    });

    it("returns empty array when queue is empty", () => {
      expect(peekSystemEvents()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // drainSystemEvents
  // -------------------------------------------------------------------------
  describe("drainSystemEvents", () => {
    it("returns all events and clears the queue", () => {
      enqueueSystemEvent("one");
      enqueueSystemEvent("two");

      const drained = drainSystemEvents();
      expect(drained).toHaveLength(2);
      expect(drained[0].text).toBe("one");
      expect(drained[1].text).toBe("two");

      // Queue should be empty now
      expect(peekSystemEvents()).toEqual([]);
    });

    it("returns empty array when queue is empty", () => {
      expect(drainSystemEvents()).toEqual([]);
    });

    it("subsequent drain returns empty after first drain", () => {
      enqueueSystemEvent("only once");
      drainSystemEvents();
      expect(drainSystemEvents()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // FIFO cap at 20
  // -------------------------------------------------------------------------
  describe("max capacity (FIFO, 20 events)", () => {
    it("holds up to 20 events", () => {
      for (let i = 0; i < 20; i++) {
        enqueueSystemEvent(`event-${i}`);
      }
      expect(peekSystemEvents()).toHaveLength(20);
    });

    it("drops oldest event when exceeding 20", () => {
      for (let i = 0; i < 21; i++) {
        enqueueSystemEvent(`event-${i}`);
      }
      const events = peekSystemEvents();
      expect(events).toHaveLength(20);
      // event-0 should have been dropped (oldest)
      expect(events[0].text).toBe("event-1");
      expect(events[19].text).toBe("event-20");
    });

    it("continues to drop oldest as more events arrive", () => {
      for (let i = 0; i < 25; i++) {
        enqueueSystemEvent(`event-${i}`);
      }
      const events = peekSystemEvents();
      expect(events).toHaveLength(20);
      expect(events[0].text).toBe("event-5");
      expect(events[19].text).toBe("event-24");
    });
  });

  // -------------------------------------------------------------------------
  // clearSystemEvents
  // -------------------------------------------------------------------------
  describe("clearSystemEvents", () => {
    it("empties the queue", () => {
      enqueueSystemEvent("to be cleared");
      clearSystemEvents();
      expect(peekSystemEvents()).toEqual([]);
    });

    it("is safe to call on an empty queue", () => {
      expect(() => clearSystemEvents()).not.toThrow();
      expect(peekSystemEvents()).toEqual([]);
    });
  });
});
