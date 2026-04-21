import { describe, it, expect } from "vitest";
import { sanitizeTelegramFinalResponse } from "./final-response-sanitize.js";

describe("sanitizeTelegramFinalResponse", () => {
  it("does not sanitize normal structured answers with headings", () => {
    const input = [
      "# Dnešní přehled",
      "",
      "- Bod A",
      "- Bod B",
      "",
      "Závěr: hotovo.",
    ].join("\n");

    const out = sanitizeTelegramFinalResponse(input);
    expect(out.didSanitize).toBe(false);
    expect(out.text).toBe(input);
  });

  it("sanitizes internal worklog headings and keeps only the final tail", () => {
    const input = [
      "**Reviewing**",
      "",
      "Some internal notes.",
      "",
      "**Evaluating**",
      "",
      "More internal stuff.",
      "",
      "Radku, tady je výsledek:",
      "",
      "- 1) Udělej A",
      "- 2) Pak B",
    ].join("\n");

    const out = sanitizeTelegramFinalResponse(input);
    expect(out.didSanitize).toBe(true);
    expect(out.text).toBe(
      ["Radku, tady je výsledek:", "", "- 1) Udělej A", "- 2) Pak B"].join("\n"),
    );
  });

  it("falls back to a short apology when it cannot safely extract a final answer", () => {
    const input = [
      "**Planning**",
      "",
      "I need to do X.",
      "",
      "**Implementing**",
      "",
      "Still working...",
    ].join("\n");

    const out = sanitizeTelegramFinalResponse(input);
    expect(out.didSanitize).toBe(true);
    expect(out.text).toMatch(/^Omlouvám se,/);
  });
});

