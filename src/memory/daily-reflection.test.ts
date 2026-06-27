import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  getYesterdayDate,
  formatInteractionsForLLM,
  parseCategories,
  callAnthropicForReflection,
  runDailyReflection,
  REFLECTION_PROMPT_PATH,
} from "./daily-reflection.js";
import { appendAuditEntry } from "./daily-log.js";
import type { AuditEntry, Config } from "../core/types.js";
import { ConfigSchema } from "../core/types.js";
import type { EpisodeRecord } from "./episodes/types.js";
import { buildEpisodeSignalsSummary } from "./reflection-episode-signals.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config["reflection"]> = {}): Config {
  return ConfigSchema.parse({
    security: {
      allowedCommands: [],
      commandsNeedingExtraValidation: [],
      workspace: "/tmp/test-workspace",
      dataDir: "/tmp/test-data",
      additionalReadDirs: [],
      additionalWriteDirs: [],
    },
    adapters: {
      telegram: { enabled: false, botToken: "x", allowedUserIds: [] },
      slack: {
        enabled: false,
        botToken: "x",
        appToken: "x",
        allowedUserIds: [],
        socketMode: false,
      },
    },
    heartbeat: {
      enabled: false,
      intervalMinutes: 30,
      activeHours: "8-22",
      deliverTo: "last",
    },
    gateway: { maxQueueSize: 10 },
    agent: { model: null, maxTurns: 5 },
    session: {
      maxHistoryMessages: 50,
      compactionEnabled: false,
      summarizationEnabled: true,
    },
    memory: {
      search: {
        enabled: false,
        hybridWeights: { vector: 0.7, keyword: 0.3 },
        minScore: 0.1,
        maxResults: 10,
        chunkTokens: 200,
        chunkOverlap: 50,
      },
      extraPaths: [],
    },
    mcpServers: {},
    codex: {},
    reflection: { enabled: true, schedule: "0 7 * * *", maxDailyLogEntries: 500, ...overrides },
  });
}

function makeInteraction(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2025-06-15T10:00:00.000Z",
    source: "telegram",
    sessionKey: "telegram--123",
    type: "interaction",
    userMessage: "What did we decide about the database schema?",
    assistantResponse: "We decided to use PostgreSQL with JSONB columns.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getYesterdayDate
// ---------------------------------------------------------------------------

describe("getYesterdayDate", () => {
  it("returns a date string one day before the provided date", () => {
    const now = new Date("2025-06-15T12:00:00.000Z");
    const result = getYesterdayDate(now);
    expect(result).toBe("2025-06-14");
  });

  it("handles month boundary correctly", () => {
    const now = new Date("2025-07-01T12:00:00.000Z");
    const result = getYesterdayDate(now);
    expect(result).toBe("2025-06-30");
  });
});

// ---------------------------------------------------------------------------
// formatInteractionsForLLM
// ---------------------------------------------------------------------------

describe("formatInteractionsForLLM", () => {
  it("formats a single entry with timestamp, user, and assistant content", () => {
    const entries: AuditEntry[] = [makeInteraction()];
    const result = formatInteractionsForLLM(entries);
    expect(result).toContain("[2025-06-15T10:00:00.000Z]");
    expect(result).toContain("User: What did we decide about the database schema?");
    expect(result).toContain("Assistant: We decided to use PostgreSQL with JSONB columns.");
  });

  it("separates multiple entries with a horizontal rule", () => {
    const entries: AuditEntry[] = [
      makeInteraction({ timestamp: "2025-06-15T10:00:00.000Z", userMessage: "First" }),
      makeInteraction({ timestamp: "2025-06-15T11:00:00.000Z", userMessage: "Second" }),
    ];
    const result = formatInteractionsForLLM(entries);
    expect(result).toContain("---");
    expect(result).toContain("User: First");
    expect(result).toContain("User: Second");
  });

  it("skips missing userMessage or assistantResponse gracefully", () => {
    const entries: AuditEntry[] = [
      makeInteraction({ userMessage: undefined, assistantResponse: "Only assistant" }),
    ];
    const result = formatInteractionsForLLM(entries);
    expect(result).not.toContain("User:");
    expect(result).toContain("Assistant: Only assistant");
  });

  it("returns empty string for empty input", () => {
    expect(formatInteractionsForLLM([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseCategories
// ---------------------------------------------------------------------------

describe("parseCategories", () => {
  it("detects all four categories when present", () => {
    const response = `
## Decisions
- Used PostgreSQL

## Lessons Learned
- Learned about JSONB

## Facts
- The DB is on port 5432

## Project Updates
- Schema migration complete
`;
    const cats = parseCategories(response);
    expect(cats).toContain("decision");
    expect(cats).toContain("lesson");
    expect(cats).toContain("fact");
    expect(cats).toContain("project-update");
  });

  it("returns only categories present in the response", () => {
    const response = `
## Decisions
- Used PostgreSQL

## Facts
- The DB is on port 5432
`;
    const cats = parseCategories(response);
    expect(cats).toEqual(["decision", "fact"]);
    expect(cats).not.toContain("lesson");
    expect(cats).not.toContain("project-update");
  });

  it("returns empty array when response has no recognized sections", () => {
    const cats = parseCategories("(nothing to extract)");
    expect(cats).toEqual([]);
  });
});

describe("buildEpisodeSignalsSummary", () => {
  it("returns a bounded structured summary for episodes matching the target date", () => {
    const episodes: EpisodeRecord[] = [
      {
        id: "ep-1",
        startedAt: "2025-06-14T09:00:00.000Z",
        endedAt: "2025-06-14T09:05:00.000Z",
        source: "github",
        sessionKey: "github--1",
        sessionId: "github--1",
        initiator: "user",
        action: "Fix issue",
        normalizedAction: "fix issue",
        summary: "Fixed issue",
        why: null,
        projectName: "personal-assistant",
        jobName: "003-personal-assistant-episodic-memory",
        issueId: "1",
        pullRequestId: null,
        detailedMemoryFile: null,
        category: "coding",
        skillsUsed: [],
        toolsUsed: ["functions.exec_command", "functions.exec_command"],
        tags: [],
        outcome: "success",
        successScore: 1,
        blockers: ["schema drift"],
        errors: [],
        evidenceIncomplete: [],
        trajectory: [],
        semanticEmbeddingText: "fixed issue",
      },
      {
        id: "ep-2",
        startedAt: "2025-06-14T10:00:00.000Z",
        endedAt: "2025-06-14T10:06:00.000Z",
        source: "github",
        sessionKey: "github--2",
        sessionId: "github--2",
        initiator: "user",
        action: "Investigate failure",
        normalizedAction: "investigate failure",
        summary: "Investigated failure",
        why: null,
        projectName: "personal-assistant",
        jobName: "003-personal-assistant-episodic-memory",
        issueId: "2",
        pullRequestId: null,
        detailedMemoryFile: null,
        category: "coding",
        skillsUsed: [],
        toolsUsed: ["functions.exec_command"],
        tags: [],
        outcome: "failure",
        successScore: 0.2,
        blockers: [],
        errors: ["schema drift"],
        evidenceIncomplete: [],
        trajectory: [],
        semanticEmbeddingText: "investigated failure",
      },
      {
        id: "ep-3",
        startedAt: "2025-06-13T09:00:00.000Z",
        endedAt: "2025-06-13T09:05:00.000Z",
        source: "github",
        sessionKey: "github--3",
        sessionId: "github--3",
        initiator: "user",
        action: "Older work",
        normalizedAction: "older work",
        summary: "Older work",
        why: null,
        projectName: "other-project",
        jobName: "other-job",
        issueId: "3",
        pullRequestId: null,
        detailedMemoryFile: null,
        category: "coding",
        skillsUsed: [],
        toolsUsed: ["other.tool"],
        tags: [],
        outcome: "success",
        successScore: 1,
        blockers: ["old blocker"],
        errors: [],
        evidenceIncomplete: [],
        trajectory: [],
        semanticEmbeddingText: "older work",
      },
    ];

    const summary = buildEpisodeSignalsSummary({
      label: "2025-06-14",
      episodes: episodes.slice(0, 2),
      maxTopItems: 2,
    });

    expect(summary).toContain("Structured episodic signals for 2025-06-14");
    expect(summary).toContain("- episodes: 2");
    expect(summary).toContain("- outcomes: failure (1), success (1)");
    expect(summary).toContain("- projects: personal-assistant (2)");
    expect(summary).toContain("- jobs: 003-personal-assistant-episodic-memory (2)");
    expect(summary).toContain("- tools: functions.exec_command (3)");
    expect(summary).toContain("- blockers/errors: schema drift (2)");
  });
});

// ---------------------------------------------------------------------------
// callAnthropicForReflection
// ---------------------------------------------------------------------------

describe("callAnthropicForReflection", () => {
  const originalApiKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "test-key-12345";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = originalApiKey;
    }
    vi.restoreAllMocks();
  });

  it("throws if ANTHROPIC_API_KEY is not set", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    await expect(
      callAnthropicForReflection("system", "conversation", "claude-haiku-4-5-20251001"),
    ).rejects.toThrow("ANTHROPIC_API_KEY is not set");
  });

  it("sends correct request structure to the Anthropic API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "## Decisions\n- Used PostgreSQL" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await callAnthropicForReflection(
      "You are a curator.",
      "User: hello\nAssistant: hi",
      "claude-haiku-4-5-20251001",
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");

    const body = JSON.parse(options.body as string);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.system).toBe("You are a curator.");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("User: hello");
    expect(body.messages[0].content).toContain("<log>");

    const headers = options.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key-12345");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("extracts text content from the API response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          { type: "text", text: "## Decisions\n- Used PostgreSQL" },
          { type: "text", text: "\n\n## Facts\n- DB on port 5432" },
        ],
      }),
    }));

    const result = await callAnthropicForReflection("system", "content", "claude-haiku-4-5-20251001");
    expect(result).toContain("## Decisions");
    expect(result).toContain("## Facts");
  });

  it("throws on non-OK API response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
    }));

    await expect(
      callAnthropicForReflection("system", "content", "claude-haiku-4-5-20251001"),
    ).rejects.toThrow("Anthropic API error (429)");
  });
});

// ---------------------------------------------------------------------------
// runDailyReflection
// ---------------------------------------------------------------------------

describe("runDailyReflection", () => {
  let tmpDir: string;
  const originalApiKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daily-reflection-test-"));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (originalApiKey === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = originalApiKey;
    }
    vi.restoreAllMocks();
  });

  function mockFetchWithResponse(text: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text }],
        }),
      }),
    );
  }

  // Get yesterday's date using the same logic as the module
  function yesterday(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  async function writeYesterdayEntry(overrides: Partial<AuditEntry> = {}) {
    const entry: AuditEntry = makeInteraction({
      timestamp: `${yesterday()}T10:00:00.000Z`,
      ...overrides,
    });
    await appendAuditEntry(tmpDir, entry);
  }

  it("creates reflection file with valid YAML frontmatter and markdown body", async () => {
    for (let i = 0; i < 3; i++) {
      await writeYesterdayEntry({ userMessage: `Question ${i}`, assistantResponse: `Answer ${i}` });
    }

    mockFetchWithResponse("## Decisions\n- Used PostgreSQL\n\n## Facts\n- DB on port 5432");

    const config = makeConfig();
    await runDailyReflection(config, tmpDir);

    const date = yesterday();
    const reflectionPath = path.join(tmpDir, "memory", `reflection-${date}.md`);
    const content = await fs.readFile(reflectionPath, "utf-8");

    expect(content).toContain("---");
    expect(content).toContain(`date: ${date}`);
    expect(content).toContain("entry_count: 3");
    expect(content).toContain("categories:");
    expect(content).toContain("- decision");
    expect(content).toContain("- fact");
    expect(content).toContain("## Decisions");
    expect(content).toContain("## Facts");
  });

  it("skips without overwriting if reflection file already exists", async () => {
    await writeYesterdayEntry();
    mockFetchWithResponse("## Decisions\n- Something");

    const config = makeConfig();
    const date = yesterday();
    const reflectionPath = path.join(tmpDir, "memory", `reflection-${date}.md`);
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
    await fs.writeFile(reflectionPath, "original content", { mode: 0o600 });

    await runDailyReflection(config, tmpDir);

    const content = await fs.readFile(reflectionPath, "utf-8");
    expect(content).toBe("original content");
    // fetch should not have been called since we skip early
    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns without error when yesterday has no daily log", async () => {
    const config = makeConfig();
    mockFetchWithResponse("## Decisions\n- Something");

    // No log file created — should complete without error
    await expect(runDailyReflection(config, tmpDir)).resolves.toBeUndefined();

    const date = yesterday();
    const reflectionPath = path.join(tmpDir, "memory", `reflection-${date}.md`);
    await expect(fs.access(reflectionPath)).rejects.toThrow();
  });

  it("skips when yesterday has only tool_call entries", async () => {
    const toolEntry: AuditEntry = {
      timestamp: `${yesterday()}T10:00:00.000Z`,
      source: "terminal",
      sessionKey: "terminal--default",
      type: "tool_call",
      toolName: "bash",
      toolInput: { command: "ls" },
      toolResult: "file.txt",
      durationMs: 50,
    };
    await appendAuditEntry(tmpDir, toolEntry);

    const config = makeConfig();
    mockFetchWithResponse("## Decisions\n- Something");

    await runDailyReflection(config, tmpDir);

    const date = yesterday();
    const reflectionPath = path.join(tmpDir, "memory", `reflection-${date}.md`);
    await expect(fs.access(reflectionPath)).rejects.toThrow();
  });

  it("skips when reflection.enabled is false", async () => {
    await writeYesterdayEntry();
    const config = makeConfig({ enabled: false });
    const mockFetchFn = vi.fn();
    vi.stubGlobal("fetch", mockFetchFn);

    await runDailyReflection(config, tmpDir);

    expect(mockFetchFn).not.toHaveBeenCalled();
  });

  it("skips when LLM returns nothing to extract sentinel", async () => {
    await writeYesterdayEntry();
    mockFetchWithResponse("(nothing to extract)");

    const config = makeConfig();
    await runDailyReflection(config, tmpDir);

    const date = yesterday();
    const reflectionPath = path.join(tmpDir, "memory", `reflection-${date}.md`);
    await expect(fs.access(reflectionPath)).rejects.toThrow();
  });

  it("respects maxDailyLogEntries config — only uses last N interactions", async () => {
    // Write 5 entries with yesterday's date
    for (let i = 0; i < 5; i++) {
      await writeYesterdayEntry({
        timestamp: `${yesterday()}T1${i}:00:00.000Z`,
        userMessage: `Question ${i}`,
        assistantResponse: `Answer ${i}`,
      });
    }

    const capturedBody: { messages: Array<{ content: string }> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody.push(JSON.parse(opts.body as string));
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "## Facts\n- test" }] }),
        };
      }),
    );

    const config = makeConfig({ maxDailyLogEntries: 3 });
    await runDailyReflection(config, tmpDir);

    expect(capturedBody).toHaveLength(1);
    const userContent = capturedBody[0].messages[0].content as string;
    // Should contain the last 3 entries (Question 2, 3, 4)
    expect(userContent).toContain("Question 2");
    expect(userContent).toContain("Question 4");
    // Should NOT contain the first entries (Question 0, 1 were cut)
    expect(userContent).not.toContain("Question 0");
    expect(userContent).not.toContain("Question 1");
  });

  it("REFLECTION_PROMPT template file exists and is readable", async () => {
    const promptContent = await fs.readFile(REFLECTION_PROMPT_PATH, "utf-8");
    expect(promptContent).toContain("Decisions");
    expect(promptContent).toContain("Lessons Learned");
    expect(promptContent).toContain("Facts");
    expect(promptContent).toContain("Project Updates");
  });

  it("uses targetDate parameter when provided instead of yesterday", async () => {
    const specificDate = "2025-11-20";
    const entry: AuditEntry = makeInteraction({
      timestamp: `${specificDate}T10:00:00.000Z`,
      userMessage: "Specific day question",
      assistantResponse: "Specific day answer",
    });
    await appendAuditEntry(tmpDir, entry);

    mockFetchWithResponse("## Facts\n- Tested targetDate parameter");

    const config = makeConfig();
    await runDailyReflection(config, tmpDir, specificDate);

    const reflectionPath = path.join(tmpDir, "memory", `reflection-${specificDate}.md`);
    const content = await fs.readFile(reflectionPath, "utf-8");
    expect(content).toContain(`date: ${specificDate}`);
    expect(content).toContain("targetDate parameter");

    // Yesterday's reflection file should NOT exist
    const yesterdayPath = path.join(tmpDir, "memory", `reflection-${yesterday()}.md`);
    await expect(fs.access(yesterdayPath)).rejects.toThrow();
  });

  it("appends bounded episode-derived signals when enabled", async () => {
    const specificDate = "2025-11-20";
    const entry: AuditEntry = makeInteraction({
      timestamp: `${specificDate}T10:00:00.000Z`,
      userMessage: "What kept failing?",
      assistantResponse: "Need a summary.",
    });
    await appendAuditEntry(tmpDir, entry);
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const listEpisodesMock = vi.fn(() => [
        {
          id: "ep-1",
          startedAt: `${specificDate}T08:00:00.000Z`,
          endedAt: `${specificDate}T08:05:00.000Z`,
          source: "github",
          sessionKey: "github--1",
          sessionId: "github--1",
          initiator: "user",
          action: "Fix issue",
          normalizedAction: "fix issue",
          summary: "Fixed issue",
          why: null,
          projectName: "personal-assistant",
          jobName: "003-personal-assistant-episodic-memory",
          issueId: "1",
          pullRequestId: null,
          detailedMemoryFile: null,
          category: "coding",
          skillsUsed: [],
          toolsUsed: ["functions.exec_command"],
          tags: [],
          outcome: "failure",
          successScore: 0.2,
          blockers: ["schema drift"],
          errors: [],
          evidenceIncomplete: [],
          trajectory: [],
          semanticEmbeddingText: "fixed issue",
        },
      ]);
    const createEpisodeStoreMock = vi.fn(() => ({
      listEpisodes: listEpisodesMock,
      close: vi.fn(),
    }));

    const capturedBody: { messages: Array<{ content: string }> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody.push(JSON.parse(opts.body as string));
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "## Facts\n- test" }] }),
        };
      }),
    );

    const config = makeConfig({
      episodeSignals: { enabled: true, maxRecentEpisodes: 5, maxTopItems: 2 },
    });
    await runDailyReflection(config, tmpDir, specificDate, {
      createEpisodeStore: createEpisodeStoreMock as any,
    });

    expect(createEpisodeStoreMock).toHaveBeenCalledWith("/tmp/test-data/episodes.db");
    expect(listEpisodesMock).toHaveBeenCalledWith({
      startedAtTo: "2025-11-20T23:59:59.999Z",
      endedAtFrom: "2025-11-20T00:00:00.000Z",
      limit: 5,
    });
    expect(capturedBody).toHaveLength(1);
    expect(capturedBody[0].messages[0].content).toContain("Structured episodic signals for 2025-11-20");
    expect(capturedBody[0].messages[0].content).toContain("schema drift");
  });

  it("passes date-aware overlap filters before applying the recent-episode bound", async () => {
    const specificDate = "2025-11-20";
    const entry: AuditEntry = makeInteraction({
      timestamp: `${specificDate}T10:00:00.000Z`,
      userMessage: "Summarize target-date work",
      assistantResponse: "Need the right episode context",
    });
    await appendAuditEntry(tmpDir, entry);
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const listEpisodesMock = vi.fn((filters?: Record<string, unknown>) => {
      if (
        filters?.["startedAtTo"] === "2025-11-20T23:59:59.999Z" &&
        filters?.["endedAtFrom"] === "2025-11-20T00:00:00.000Z" &&
        filters?.["limit"] === 1
      ) {
        return [
          {
            id: "target-date-episode",
            startedAt: "2025-11-19T23:55:00.000Z",
            endedAt: "2025-11-20T00:10:00.000Z",
            source: "github",
            sessionKey: "github--target",
            sessionId: "github--target",
            initiator: "user",
            action: "Carry midnight fix over the line",
            normalizedAction: "carry midnight fix over the line",
            summary: "Finished the target-date fix after midnight.",
            why: null,
            projectName: "personal-assistant",
            jobName: "003-personal-assistant-episodic-memory",
            issueId: "99",
            pullRequestId: null,
            detailedMemoryFile: null,
            category: "coding",
            skillsUsed: [],
            toolsUsed: ["functions.exec_command"],
            tags: [],
            outcome: "success",
            successScore: 1,
            blockers: [],
            errors: ["late-night regression"],
            evidenceIncomplete: [],
            trajectory: [],
            semanticEmbeddingText: "midnight fix",
          },
        ];
      }
      return [];
    });
    const createEpisodeStoreMock = vi.fn(() => ({
      listEpisodes: listEpisodesMock,
      close: vi.fn(),
    }));

    const capturedBody: { messages: Array<{ content: string }> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody.push(JSON.parse(opts.body as string));
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "## Facts\n- target date preserved" }] }),
        };
      }),
    );

    const config = makeConfig({
      episodeSignals: { enabled: true, maxRecentEpisodes: 1, maxTopItems: 2 },
    });
    await runDailyReflection(config, tmpDir, specificDate, {
      createEpisodeStore: createEpisodeStoreMock as any,
    });

    expect(listEpisodesMock).toHaveBeenCalledOnce();
    expect(capturedBody[0].messages[0].content).toContain("Structured episodic signals for 2025-11-20");
    expect(capturedBody[0].messages[0].content).toContain("late-night regression");
    expect(capturedBody[0].messages[0].content).toContain("- outcomes: success (1)");
  });

  it("does not touch the episodic store when episode signals are disabled", async () => {
    const specificDate = "2025-11-20";
    const entry: AuditEntry = makeInteraction({
      timestamp: `${specificDate}T10:00:00.000Z`,
    });
    await appendAuditEntry(tmpDir, entry);

    const createEpisodeStoreMock = vi.fn();
    mockFetchWithResponse("## Facts\n- No episodic context");

    await runDailyReflection(makeConfig(), tmpDir, specificDate, {
      createEpisodeStore: createEpisodeStoreMock as any,
    });

    expect(createEpisodeStoreMock).not.toHaveBeenCalled();
  });

  it("continues daily reflection when episode signal loading fails", async () => {
    const specificDate = "2025-11-20";
    const entry: AuditEntry = makeInteraction({
      timestamp: `${specificDate}T10:00:00.000Z`,
      userMessage: "Summarize the day",
      assistantResponse: "Working on it",
    });
    await appendAuditEntry(tmpDir, entry);
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const createEpisodeStoreMock = vi.fn(() => {
      throw new Error("episodes.db incompatible schema");
    });
    const capturedBody: { messages: Array<{ content: string }> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody.push(JSON.parse(opts.body as string));
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "## Facts\n- still works" }] }),
        };
      }),
    );

    const config = makeConfig({
      episodeSignals: { enabled: true, maxRecentEpisodes: 5, maxTopItems: 2 },
    });
    await runDailyReflection(config, tmpDir, specificDate, {
      createEpisodeStore: createEpisodeStoreMock as any,
    });

    expect(capturedBody).toHaveLength(1);
    expect(capturedBody[0].messages[0].content).toContain("User: Summarize the day");
    expect(capturedBody[0].messages[0].content).not.toContain("Structured episodic signals");
    const reflectionPath = path.join(tmpDir, "memory", `reflection-${specificDate}.md`);
    await expect(fs.access(reflectionPath)).resolves.toBeUndefined();
  });

  it("keeps episode-derived prompt content when store close fails after a successful load", async () => {
    const specificDate = "2025-11-20";
    const entry: AuditEntry = makeInteraction({
      timestamp: `${specificDate}T10:00:00.000Z`,
      userMessage: "Summarize the day",
      assistantResponse: "Working on it",
    });
    await appendAuditEntry(tmpDir, entry);
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const capturedBody: { messages: Array<{ content: string }> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody.push(JSON.parse(opts.body as string));
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "## Facts\n- still works" }] }),
        };
      }),
    );

    const config = makeConfig({
      episodeSignals: { enabled: true, maxRecentEpisodes: 5, maxTopItems: 2 },
    });
    await runDailyReflection(config, tmpDir, specificDate, {
      createEpisodeStore: (() => ({
        listEpisodes: () => [{
          id: "ep-1",
          startedAt: `${specificDate}T08:00:00.000Z`,
          endedAt: `${specificDate}T08:05:00.000Z`,
          source: "github",
          sessionKey: "github--1",
          sessionId: "github--1",
          initiator: "user",
          action: "Fix issue",
          normalizedAction: "fix issue",
          summary: "Fixed issue",
          why: null,
          projectName: "personal-assistant",
          jobName: "003-personal-assistant-episodic-memory",
          issueId: "1",
          pullRequestId: null,
          detailedMemoryFile: null,
          category: "coding",
          skillsUsed: [],
          toolsUsed: ["functions.exec_command"],
          tags: [],
          outcome: "failure",
          successScore: 0.2,
          blockers: ["schema drift"],
          errors: [],
          evidenceIncomplete: [],
          trajectory: [],
          semanticEmbeddingText: "fixed issue",
        }, {
          id: "ep-2",
          startedAt: `${specificDate}T09:00:00.000Z`,
          endedAt: `${specificDate}T09:04:00.000Z`,
          source: "github",
          sessionKey: "github--2",
          sessionId: "github--2",
          initiator: "user",
          action: "Retry issue",
          normalizedAction: "retry issue",
          summary: "Retried issue",
          why: null,
          projectName: "personal-assistant",
          jobName: "003-personal-assistant-episodic-memory",
          issueId: "2",
          pullRequestId: null,
          detailedMemoryFile: null,
          category: "coding",
          skillsUsed: [],
          toolsUsed: ["functions.exec_command"],
          tags: [],
          outcome: "success",
          successScore: 1,
          blockers: [],
          errors: ["schema drift"],
          evidenceIncomplete: [],
          trajectory: [],
          semanticEmbeddingText: "retried issue",
        }],
        close: () => {
          throw new Error("close failed");
        },
      })) as any,
    });

    expect(capturedBody).toHaveLength(1);
    expect(capturedBody[0].messages[0].content).toContain("Structured episodic signals for 2025-11-20");
    expect(capturedBody[0].messages[0].content).toContain("schema drift");
    expect(capturedBody[0].messages[0].content).toContain("promotion hints are advisory only");
  });

  it("continues daily reflection without episodic summary when both list and close fail", async () => {
    const specificDate = "2025-11-20";
    const entry: AuditEntry = makeInteraction({
      timestamp: `${specificDate}T10:00:00.000Z`,
      userMessage: "Summarize the day",
      assistantResponse: "Working on it",
    });
    await appendAuditEntry(tmpDir, entry);
    await fs.mkdir("/tmp/test-data", { recursive: true });
    await fs.writeFile("/tmp/test-data/episodes.db", "");

    const capturedBody: { messages: Array<{ content: string }> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        capturedBody.push(JSON.parse(opts.body as string));
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "## Facts\n- still works" }] }),
        };
      }),
    );

    const config = makeConfig({
      episodeSignals: { enabled: true, maxRecentEpisodes: 5, maxTopItems: 2 },
    });
    await runDailyReflection(config, tmpDir, specificDate, {
      createEpisodeStore: (() => ({
        listEpisodes: () => {
          throw new Error("episodes.db read failure");
        },
        close: () => {
          throw new Error("close failed");
        },
      })) as any,
    });

    expect(capturedBody).toHaveLength(1);
    expect(capturedBody[0].messages[0].content).toContain("User: Summarize the day");
    expect(capturedBody[0].messages[0].content).not.toContain("Structured episodic signals");
  });
});
