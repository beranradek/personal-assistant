import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSpinner } from "./spinner.js";

describe("Spinner", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    writeSpy.mockRestore();
  });

  it("writes a spinner frame on start", () => {
    const spinner = createSpinner();
    spinner.start("Loading...");

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain("\r");
    expect(output).toContain("Loading...");

    spinner.stop();
  });

  it("advances frames on interval ticks", () => {
    const spinner = createSpinner();
    spinner.start();

    const firstFrame = (writeSpy.mock.calls[0][0] as string);

    vi.advanceTimersByTime(80);
    expect(writeSpy).toHaveBeenCalledTimes(2);

    const secondFrame = (writeSpy.mock.calls[1][0] as string);
    // Frames should differ (different braille character)
    expect(firstFrame).not.toBe(secondFrame);

    spinner.stop();
  });

  it("clears the line on stop", () => {
    const spinner = createSpinner();
    spinner.start();
    writeSpy.mockClear();

    spinner.stop();

    expect(writeSpy).toHaveBeenCalledWith("\r\x1b[K");
  });

  it("reports spinning state correctly", () => {
    const spinner = createSpinner();

    expect(spinner.isSpinning()).toBe(false);
    spinner.start();
    expect(spinner.isSpinning()).toBe(true);
    spinner.stop();
    expect(spinner.isSpinning()).toBe(false);
  });

  it("does not create duplicate intervals on double start", () => {
    const spinner = createSpinner();
    spinner.start();
    spinner.start(); // second call should be ignored

    vi.advanceTimersByTime(80);
    // 1 initial write + 1 tick = 2, not 3
    expect(writeSpy).toHaveBeenCalledTimes(2);

    spinner.stop();
  });

  it("stop is safe to call when not spinning", () => {
    const spinner = createSpinner();
    expect(() => spinner.stop()).not.toThrow();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
