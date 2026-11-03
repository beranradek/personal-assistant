import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { lintMemoryKnowledgeBase } from "./linter.js";

describe("lintMemoryKnowledgeBase", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-linter-test-"));
    await fs.mkdir(path.join(workspaceDir, "memory", "people"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("accepts valid relative links and reports no issues", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "memory", "index.md"),
      "---\ntype: Index\ntitle: Knowledge base\n---\n[Jane](people/jane.md#context)\n",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "people", "jane.md"),
      "---\ntype: Person\ntitle: Jane\n---\n## Context\n",
    );

    const result = await lintMemoryKnowledgeBase(workspaceDir);

    expect(result.issues).toEqual([]);
    expect(result.filesScanned).toBe(2);
  });

  it("reports missing files and missing heading anchors", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "memory", "index.md"),
      "---\ntype: Index\ntitle: Knowledge base\n---\n[Missing](people/nope.md) [Anchor](people/jane.md#missing)\n",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "people", "jane.md"),
      "---\ntype: Person\ntitle: Jane\n---\n## Context\n",
    );

    const result = await lintMemoryKnowledgeBase(workspaceDir);

    expect(result.issues.map((issue) => issue.code)).toEqual([
      "broken-link",
      "broken-anchor",
    ]);
  });

  it("reports duplicate canonical type and title", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "memory", "index.md"),
      "---\ntype: Project\ntitle: Personal Assistant\n---\n# One\n",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "people", "duplicate.md"),
      "---\ntype: project\ntitle: personal assistant\n---\n# Two\n",
    );

    const result = await lintMemoryKnowledgeBase(workspaceDir);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: "duplicate-entity", severity: "warning" });
  });

  it("accepts an existing workspace asset outside the memory graph", async () => {
    await fs.mkdir(path.join(workspaceDir, "documents"));
    await fs.writeFile(path.join(workspaceDir, "documents", "diagram.png"), "png");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "index.md"),
      "---\ntype: Index\ntitle: Knowledge base\n---\n![Diagram](../documents/diagram.png)\n",
    );

    const result = await lintMemoryKnowledgeBase(workspaceDir);

    expect(result.issues).toEqual([]);
  });
});
