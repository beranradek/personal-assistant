import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../core/types.js";
import { buildEpisodeFromAuditEntries } from "./builder.js";

describe("buildEpisodeFromAuditEntries", () => {
  it("builds a deterministic episode from bounded audit entries", () => {
    const entries: AuditEntry[] = [
      {
        timestamp: "2026-06-18T12:00:00.000Z",
        source: "github",
        sessionKey: "github--owner/repo#123",
        type: "interaction",
        userMessage: "Implement deterministic episode builder",
        assistantResponse: "Starting with tests first.",
        taskContext: {
          projectName: "personal-assistant",
          jobName: "003-personal-assistant-episodic-memory",
          issueId: "owner/repo#123",
          category: "coding",
        },
      },
      {
        timestamp: "2026-06-18T12:01:00.000Z",
        source: "github",
        sessionKey: "github--owner/repo#123",
        type: "tool_call",
        toolName: "functions.exec_command",
        toolInput: { cmd: "pnpm test -- src/memory/episodes/builder.test.ts" },
        toolResult: { exitCode: 1 },
        durationMs: 930,
      },
      {
        timestamp: "2026-06-18T12:02:00.000Z",
        source: "github",
        sessionKey: "github--owner/repo#123",
        type: "error",
        errorMessage: "Expected test failure before implementation",
        context: "red phase",
        taskContext: {
          detailedMemoryFile: "memory/personal-assistant-episodic-memory.md",
        },
      },
      {
        timestamp: "2026-06-18T12:04:00.000Z",
        source: "github",
        sessionKey: "github--owner/repo#123",
        type: "interaction",
        userMessage: "Continue",
        assistantResponse: "Implemented the builder and tests now pass.",
        taskContext: {
          pullRequestId: "456",
        },
      },
    ];

    const episode = buildEpisodeFromAuditEntries(entries, {
      id: "ep-builder-1",
      why: "Slice 3 for episodic memory plan",
      skillsUsed: ["tdd-workflow"],
    });

    expect(episode).toMatchObject({
      id: "ep-builder-1",
      startedAt: "2026-06-18T12:00:00.000Z",
      endedAt: "2026-06-18T12:04:00.000Z",
      source: "github",
      sessionKey: "github--owner/repo#123",
      initiator: "user",
      action: "Implement deterministic episode builder",
      normalizedAction: "implement deterministic episode builder",
      summary: "Implemented the builder and tests now pass.",
      why: "Slice 3 for episodic memory plan",
      projectName: "personal-assistant",
      jobName: "003-personal-assistant-episodic-memory",
      issueId: "owner/repo#123",
      pullRequestId: "456",
      detailedMemoryFile: "memory/personal-assistant-episodic-memory.md",
      category: "coding",
      skillsUsed: ["tdd-workflow"],
      toolsUsed: ["functions.exec_command"],
      outcome: "partial_success",
      errors: ["Expected test failure before implementation"],
    });
    expect(episode.tags).toEqual(["coding", "github", "personal-assistant"]);
    expect(episode.successScore).toBe(0.6);
    expect(episode.blockers).toEqual([]);
    expect(episode.openQuestions).toEqual([]);
    expect(episode.trajectory).toEqual([
      {
        at: "2026-06-18T12:00:00.000Z",
        kind: "action",
        label: "Implement deterministic episode builder",
        data: { auditIndex: 0, source: "github", type: "interaction" },
      },
      {
        at: "2026-06-18T12:00:00.000Z",
        kind: "observation",
        label: "Starting with tests first.",
        data: { auditIndex: 0, source: "github", type: "interaction" },
      },
      {
        at: "2026-06-18T12:01:00.000Z",
        kind: "tool_call",
        label: "functions.exec_command",
        data: {
          auditIndex: 1,
          source: "github",
          type: "tool_call",
          hasInput: true,
          inputKeys: ["cmd"],
        },
      },
      {
        at: "2026-06-18T12:01:00.000Z",
        kind: "tool_result",
        label: "functions.exec_command",
        data: {
          auditIndex: 1,
          source: "github",
          type: "tool_call",
          durationMs: 930,
          hasResult: true,
          resultType: "object",
        },
      },
      {
        at: "2026-06-18T12:02:00.000Z",
        kind: "observation",
        label: "Expected test failure before implementation",
        data: { auditIndex: 2, source: "github", type: "error", context: "red phase" },
      },
      {
        at: "2026-06-18T12:04:00.000Z",
        kind: "action",
        label: "Continue",
        data: { auditIndex: 3, source: "github", type: "interaction" },
      },
      {
        at: "2026-06-18T12:04:00.000Z",
        kind: "observation",
        label: "Implemented the builder and tests now pass.",
        data: { auditIndex: 3, source: "github", type: "interaction" },
      },
    ]);
    expect(episode.semanticEmbeddingText).toContain("Implement deterministic episode builder");
    expect(episode.semanticEmbeddingText).toContain("partial_success");
    expect(episode.semanticEmbeddingText).toContain("functions.exec_command");
  });

  it("marks incomplete evidence when the bounded window lacks a final assistant response", () => {
    const entries: AuditEntry[] = [
      {
        timestamp: "2026-06-18T13:00:00.000Z",
        source: "heartbeat",
        sessionKey: "heartbeat--default",
        type: "interaction",
        userMessage: "Continue with active job",
      },
      {
        timestamp: "2026-06-18T13:01:00.000Z",
        source: "heartbeat",
        sessionKey: "heartbeat--default",
        type: "tool_call",
        toolName: "functions.exec_command",
        toolInput: { cmd: "pnpm build" },
      },
    ];

    const episode = buildEpisodeFromAuditEntries(entries, {
      id: "ep-builder-incomplete",
    });

    expect(episode.initiator).toBe("heartbeat");
    expect(episode.outcome).toBe("aborted");
    expect(episode.summary).toBe("Continue with active job");
    expect(episode.openQuestions).toEqual([
      "missing assistant response in bounded audit window",
      "missing terminal outcome in bounded audit window",
    ]);
    expect(episode.successScore).toBe(0.2);
  });

  it("rejects empty entry sets and mixed session keys", () => {
    expect(() => buildEpisodeFromAuditEntries([])).toThrow(
      "Cannot build episode from empty audit entry set",
    );

    expect(() =>
      buildEpisodeFromAuditEntries([
        {
          timestamp: "2026-06-18T13:00:00.000Z",
          source: "terminal",
          sessionKey: "terminal--1",
          type: "interaction",
          userMessage: "A",
          assistantResponse: "B",
        },
        {
          timestamp: "2026-06-18T13:01:00.000Z",
          source: "terminal",
          sessionKey: "terminal--2",
          type: "interaction",
          userMessage: "C",
          assistantResponse: "D",
        },
      ]),
    ).toThrow("Cannot build episode from multiple session keys");
  });

  it("includes entry content in default ids to avoid structural collisions", () => {
    const episodeA = buildEpisodeFromAuditEntries([
      {
        timestamp: "2026-06-18T13:00:00.000Z",
        source: "terminal",
        sessionKey: "terminal--1",
        type: "interaction",
        userMessage: "Implement A",
        assistantResponse: "Done A",
      },
    ]);
    const episodeB = buildEpisodeFromAuditEntries([
      {
        timestamp: "2026-06-18T13:00:00.000Z",
        source: "terminal",
        sessionKey: "terminal--1",
        type: "interaction",
        userMessage: "Implement B",
        assistantResponse: "Done B",
      },
    ]);

    expect(episodeA.id).not.toBe(episodeB.id);
  });

  it("treats windows with trailing errors and no success evidence as failures", () => {
    const episode = buildEpisodeFromAuditEntries([
      {
        timestamp: "2026-06-18T14:00:00.000Z",
        source: "terminal",
        sessionKey: "terminal--failure",
        type: "interaction",
        userMessage: "Starting work",
        assistantResponse: "Starting now.",
      },
      {
        timestamp: "2026-06-18T14:01:00.000Z",
        source: "terminal",
        sessionKey: "terminal--failure",
        type: "error",
        errorMessage: "Build failed",
      },
      {
        timestamp: "2026-06-18T14:02:00.000Z",
        source: "terminal",
        sessionKey: "terminal--failure",
        type: "tool_call",
        toolName: "functions.exec_command",
        toolInput: { cmd: "cleanup" },
      },
    ]);

    expect(episode.outcome).toBe("failure");
    expect(episode.successScore).toBe(0);
    expect(episode.openQuestions).toEqual([
      "missing terminal outcome in bounded audit window",
    ]);
    expect(episode.trajectory).toContainEqual({
      at: "2026-06-18T14:02:00.000Z",
      kind: "tool_call",
      label: "functions.exec_command",
      data: {
        auditIndex: 2,
        source: "terminal",
        type: "tool_call",
        hasInput: true,
        inputKeys: ["cmd"],
      },
    });
  });
});
