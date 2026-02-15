import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { createPasteInterceptor, enableBracketedPaste, disableBracketedPaste } from "./paste.js";

describe("PasteInterceptor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes normal text through unchanged", async () => {
    const onPaste = vi.fn();
    const interceptor = createPasteInterceptor({ onPaste });
    const input = new PassThrough({ encoding: "utf-8" });

    const chunks: string[] = [];
    interceptor.on("data", (chunk: string) => chunks.push(chunk));

    input.pipe(interceptor);
    input.write("hello world");
    input.end();

    await new Promise((resolve) => interceptor.on("end", resolve));

    expect(chunks.join("")).toBe("hello world");
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("captures pasted text via onPaste callback", async () => {
    const onPaste = vi.fn();
    const interceptor = createPasteInterceptor({ onPaste });
    const input = new PassThrough({ encoding: "utf-8" });

    interceptor.resume(); // drain readable side so "end" fires
    input.pipe(interceptor);
    input.write("\x1b[200~pasted content\x1b[201~");
    input.end();

    await new Promise((resolve) => interceptor.on("end", resolve));

    expect(onPaste).toHaveBeenCalledWith("pasted content");
  });

  it("strips paste markers from output", async () => {
    const onPaste = vi.fn();
    const interceptor = createPasteInterceptor({ onPaste });
    const input = new PassThrough({ encoding: "utf-8" });

    const chunks: string[] = [];
    interceptor.on("data", (chunk: string) => chunks.push(chunk));

    input.pipe(interceptor);
    input.write("\x1b[200~pasted\x1b[201~");
    input.end();

    await new Promise((resolve) => interceptor.on("end", resolve));

    // The pasted text should be delivered via onPaste, not through the stream
    expect(chunks.join("")).toBe("");
    expect(onPaste).toHaveBeenCalledWith("pasted");
  });

  it("passes text before and after paste markers through", async () => {
    const onPaste = vi.fn();
    const interceptor = createPasteInterceptor({ onPaste });
    const input = new PassThrough({ encoding: "utf-8" });

    const chunks: string[] = [];
    interceptor.on("data", (chunk: string) => chunks.push(chunk));

    input.pipe(interceptor);
    input.write("before\x1b[200~pasted\x1b[201~after");
    input.end();

    await new Promise((resolve) => interceptor.on("end", resolve));

    expect(chunks.join("")).toBe("beforeafter");
    expect(onPaste).toHaveBeenCalledWith("pasted");
  });

  it("handles multiline pasted text", async () => {
    const onPaste = vi.fn();
    const interceptor = createPasteInterceptor({ onPaste });
    const input = new PassThrough({ encoding: "utf-8" });

    interceptor.resume(); // drain readable side so "end" fires
    input.pipe(interceptor);
    input.write("\x1b[200~line one\nline two\nline three\x1b[201~");
    input.end();

    await new Promise((resolve) => interceptor.on("end", resolve));

    expect(onPaste).toHaveBeenCalledWith("line one\nline two\nline three");
  });

  it("handles paste markers split across chunks", async () => {
    const onPaste = vi.fn();
    const interceptor = createPasteInterceptor({ onPaste });
    const input = new PassThrough({ encoding: "utf-8" });

    interceptor.resume(); // drain readable side so "end" fires
    input.pipe(interceptor);
    // Start marker in first chunk, content in second, end marker in third
    input.write("\x1b[200~first part ");
    input.write("second part");
    input.write("\x1b[201~");
    input.end();

    await new Promise((resolve) => interceptor.on("end", resolve));

    expect(onPaste).toHaveBeenCalledWith("first part second part");
  });

  it("handles multiple sequential pastes", async () => {
    const onPaste = vi.fn();
    const interceptor = createPasteInterceptor({ onPaste });
    const input = new PassThrough({ encoding: "utf-8" });

    interceptor.resume(); // drain readable side so "end" fires
    input.pipe(interceptor);
    input.write("\x1b[200~first paste\x1b[201~");
    input.write("\x1b[200~second paste\x1b[201~");
    input.end();

    await new Promise((resolve) => interceptor.on("end", resolve));

    expect(onPaste).toHaveBeenCalledTimes(2);
    expect(onPaste).toHaveBeenNthCalledWith(1, "first paste");
    expect(onPaste).toHaveBeenNthCalledWith(2, "second paste");
  });
});

describe("enableBracketedPaste / disableBracketedPaste", () => {
  it("writes enable escape sequence to stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    enableBracketedPaste();
    expect(writeSpy).toHaveBeenCalledWith("\x1b[?2004h");
  });

  it("writes disable escape sequence to stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    disableBracketedPaste();
    expect(writeSpy).toHaveBeenCalledWith("\x1b[?2004l");
  });
});
