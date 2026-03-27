import { describe, it, expect, vi, afterEach } from "vitest";
import { TtlMap } from "./ttl-map.js";

describe("TtlMap", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns stored value before TTL expires", () => {
    const map = new TtlMap<string, number>(1000);
    map.set("a", 42);
    expect(map.get("a")).toBe(42);
  });

  it("has() returns true before TTL expires", () => {
    const map = new TtlMap<string, number>(1000);
    map.set("a", 42);
    expect(map.has("a")).toBe(true);
  });

  it("get() returns undefined after TTL expires", () => {
    vi.useFakeTimers();
    const map = new TtlMap<string, number>(1000);
    map.set("a", 42);
    vi.advanceTimersByTime(1001);
    expect(map.get("a")).toBeUndefined();
  });

  it("has() returns false after TTL expires", () => {
    vi.useFakeTimers();
    const map = new TtlMap<string, number>(1000);
    map.set("a", 42);
    vi.advanceTimersByTime(1001);
    expect(map.has("a")).toBe(false);
  });

  it("set() resets the TTL for an existing key", () => {
    vi.useFakeTimers();
    const map = new TtlMap<string, number>(1000);
    map.set("a", 1);
    vi.advanceTimersByTime(900); // near expiry
    map.set("a", 2);            // reset TTL
    vi.advanceTimersByTime(600); // 900+600 > 1000 but TTL was reset at t=900
    expect(map.get("a")).toBe(2);
  });

  it("set() updates the stored value", () => {
    const map = new TtlMap<string, number>(1000);
    map.set("a", 1);
    map.set("a", 99);
    expect(map.get("a")).toBe(99);
  });

  it("delete() removes an existing entry", () => {
    const map = new TtlMap<string, number>(1000);
    map.set("a", 42);
    map.delete("a");
    expect(map.get("a")).toBeUndefined();
  });

  it("delete() on a nonexistent key does not throw", () => {
    const map = new TtlMap<string, number>(1000);
    expect(() => map.delete("missing")).not.toThrow();
  });

  it("delete() on an already-expired key does not throw", () => {
    vi.useFakeTimers();
    const map = new TtlMap<string, number>(1000);
    map.set("a", 1);
    vi.advanceTimersByTime(2000);
    expect(() => map.delete("a")).not.toThrow();
  });

  it("clear() removes all entries", () => {
    const map = new TtlMap<string, number>(1000);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.clear();
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBeUndefined();
  });

  it("multiple independent keys each have their own TTL", () => {
    vi.useFakeTimers();
    const map = new TtlMap<string, number>(1000);
    map.set("a", 1);
    vi.advanceTimersByTime(500);
    map.set("b", 2); // set later — expires at t=1500
    vi.advanceTimersByTime(600); // t=1100: a expired, b still alive
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
  });

  it("get() after expiry evicts the entry so a subsequent set works cleanly", () => {
    vi.useFakeTimers();
    const map = new TtlMap<string, number>(1000);
    map.set("a", 1);
    vi.advanceTimersByTime(2000);
    expect(map.get("a")).toBeUndefined(); // evicts
    map.set("a", 99);
    expect(map.get("a")).toBe(99);
  });
});
