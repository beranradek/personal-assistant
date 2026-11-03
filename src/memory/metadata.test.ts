import { describe, expect, it } from "vitest";
import {
  matchesMemoryFilters,
  parseMemoryMetadata,
  type MemorySearchFilters,
} from "./metadata.js";

describe("parseMemoryMetadata", () => {
  it("parses OKF-lite frontmatter and preserves the markdown body", () => {
    const result = parseMemoryMetadata(`---
type: Person
title: Jan Novák
tags: [colleague, Etnetera]
last_reviewed: 2026-11-03
---
# Jan Novák
`);

    expect(result.metadata).toEqual({
      type: "Person",
      title: "Jan Novák",
      tags: ["colleague", "Etnetera"],
      lastReviewed: "2026-11-03",
    });
    expect(result.body).toContain("# Jan Novák");
    expect(result.issues).toEqual([]);
  });

  it("reports invalid YAML without treating it as valid metadata", () => {
    const result = parseMemoryMetadata("---\ntype: [broken\n---\n# Broken");

    expect(result.metadata).toEqual({});
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("invalid-frontmatter");
  });

  it("reports non-string type and non-string tag entries", () => {
    const result = parseMemoryMetadata("---\ntype: 12\ntags: [valid, 3]\n---\n# Page");

    expect(result.metadata).toEqual({ tags: ["valid"] });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "invalid-type",
      "invalid-tags",
    ]);
  });
});

describe("matchesMemoryFilters", () => {
  const metadata = {
    type: "Project",
    tags: ["health", "mobile"],
  };

  it.each<[MemorySearchFilters, boolean]>([
    [{}, true],
    [{ type: "project" }, true],
    [{ type: "person" }, false],
    [{ tags: ["health"] }, true],
    [{ tags: ["health", "mobile"] }, true],
    [{ tags: ["health", "web"] }, false],
  ])("matches %o as %s", (filters, expected) => {
    expect(matchesMemoryFilters(metadata, filters)).toBe(expected);
  });
});
