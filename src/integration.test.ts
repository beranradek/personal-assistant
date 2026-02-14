/**
 * Integration Tests
 * =================
 *
 * End-to-end tests that verify multiple modules work together correctly.
 * Each test exercises a pipeline of modules in sequence rather than testing
 * a single module in isolation.
 *
 * - Config -> workspace -> memory files -> agent options (full pipeline)
 * - Security hook blocks dangerous commands in full pipeline
 * - Hybrid search returns results for indexed content
 * - Queue processes messages in order
 * - System events flow from enqueue -> heartbeat -> prompt resolution
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Mocks (must be before imports of modules that use them)
// ---------------------------------------------------------------------------

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./core/logger.js", () => ({
  createLogger: () => mockLog,
}));

// Mock the agent runner (needed for queue processLoop tests)
vi.mock("./core/agent-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./core/agent-runner.js")>();
  return {
    ...actual,
    runAgentTurn: vi.fn(),
  };
});

// Mock the session manager (needed for queue processNext)
vi.mock("./session/manager.js", () => ({
  resolveSessionKey: vi.fn(
    (source: string, sourceId: string) => `${source}--${sourceId}`,
  ),
  saveInteraction: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------

import { loadConfig } from "./core/config.js";
import { ensureWorkspace } from "./core/workspace.js";
import { readMemoryFiles } from "./memory/files.js";
import { buildAgentOptions, runAgentTurn } from "./core/agent-runner.js";
import { bashSecurityHook } from "./security/bash-hook.js";
import { createVectorStore, type VectorStore } from "./memory/vector-store.js";
import {
  createMockEmbeddingProvider,
  type EmbeddingProvider,
} from "./memory/embeddings.js";
import { createIndexer, type Indexer } from "./memory/indexer.js";
import { hybridSearch, type HybridSearchConfig } from "./memory/hybrid-search.js";
import { createMessageQueue } from "./gateway/queue.js";
import { createRouter } from "./gateway/router.js";
import {
  enqueueSystemEvent,
  drainSystemEvents,
  clearSystemEvents,
} from "./heartbeat/system-events.js";
import { resolveHeartbeatPrompt } from "./heartbeat/prompts.js";
import type { Config, Adapter, AdapterMessage } from "./core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid Config object pointing at a temp directory.
 */
function makeConfig(
  workspaceDir: string,
  dataDir: string,
  overrides?: Partial<Config>,
): Config {
  return {
    security: {
      allowedCommands: [
        "ls", "cat", "grep", "head", "tail", "wc", "sort", "uniq", "find",
        "echo", "pwd", "date", "whoami", "env", "which", "file", "stat",
        "du", "df", "diff", "tr", "cut", "sed", "awk", "xargs",
        "node", "npm", "npx", "git",
        "curl", "wget", "tar", "gzip", "gunzip", "zip", "unzip", "jq",
        "python", "python3", "pip", "pip3", "make",
        "mkdir", "rmdir", "touch", "cp", "mv", "rm", "chmod", "ln", "tee",
        "kill", "pkill",
      ],
      commandsNeedingExtraValidation: ["rm", "rmdir", "kill", "chmod", "curl"],
      workspace: workspaceDir,
      dataDir,
      additionalReadDirs: [],
      additionalWriteDirs: [],
    },
    adapters: {
      telegram: { enabled: false, botToken: "", allowedUserIds: [], mode: "polling" as const },
      slack: { enabled: false, botToken: "", appToken: "", socketMode: false },
    },
    heartbeat: {
      enabled: true,
      intervalMinutes: 30,
      activeHours: "8-21",
      deliverTo: "last" as const,
    },
    gateway: { maxQueueSize: 20 },
    agent: { model: null, maxTurns: 200 },
    session: { maxHistoryMessages: 50, compactionEnabled: true },
    memory: {
      search: {
        enabled: true,
        hybridWeights: { vector: 0.7, keyword: 0.3 },
        minScore: 0.35,
        maxResults: 6,
        chunkTokens: 400,
        chunkOverlap: 80,
      },
      extraPaths: [],
    },
    mcpServers: {},
    ...overrides,
  } as Config;
}

function makeAdapter(name: string): Adapter & { sendResponse: ReturnType<typeof vi.fn> } {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendResponse: vi.fn().mockResolvedValue(undefined),
  };
}

// ===========================================================================
// Test 1: Config -> Workspace -> Memory Files -> Agent Options (full pipeline)
// ===========================================================================

describe("Integration: Config -> Workspace -> Memory Files -> Agent Options", () => {
  let tmpDir: string;
  let configDir: string;
  let workspaceDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "integration-pipeline-"));
    configDir = path.join(tmpDir, "config");
    workspaceDir = path.join(tmpDir, "workspace");
    dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads config, bootstraps workspace, reads memory files, and builds agent options", async () => {
    // Step 1: Write a settings.json and load config
    const settings = {
      security: {
        workspace: workspaceDir,
        dataDir,
      },
      agent: { maxTurns: 50 },
    };
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify(settings),
    );

    const config = loadConfig(configDir);

    // Verify config loaded correctly
    expect(config.security.workspace).toBe(workspaceDir);
    expect(config.security.dataDir).toBe(dataDir);
    expect(config.agent.maxTurns).toBe(50);
    // Defaults should be merged in
    expect(config.heartbeat.intervalMinutes).toBe(30);
    expect(config.gateway.maxQueueSize).toBe(20);

    // Step 2: Ensure workspace is bootstrapped
    await ensureWorkspace(config);

    // Verify workspace structure exists
    expect(fs.existsSync(workspaceDir)).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, "daily"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, ".claude", "skills"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "sessions"))).toBe(true);

    // Verify template files exist
    for (const file of ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"]) {
      expect(fs.existsSync(path.join(workspaceDir, file))).toBe(true);
    }

    // Step 3: Read memory files
    const memoryContent = await readMemoryFiles(workspaceDir, {
      includeHeartbeat: true,
    });

    // Memory content should be non-empty (templates have content)
    expect(memoryContent.length).toBeGreaterThan(0);
    // Should contain separator between files
    expect(memoryContent).toContain("---");

    // Step 4: Build agent options
    const mcpServers = { memory: { command: "node", args: ["memory-server.js"] } };
    const agentOptions = buildAgentOptions(
      config,
      workspaceDir,
      memoryContent,
      mcpServers,
    );

    // Verify agent options are fully constructed
    expect(agentOptions.systemPrompt.type).toBe("preset");
    expect(agentOptions.systemPrompt.preset).toBe("claude_code");
    expect(agentOptions.systemPrompt.append).toBe(memoryContent);
    expect(agentOptions.cwd).toBe(workspaceDir);
    expect(agentOptions.maxTurns).toBe(50);
    expect(agentOptions.model).toBeUndefined(); // config.agent.model is null
    expect(agentOptions.mcpServers).toEqual(mcpServers);
    expect(agentOptions.allowedTools).toContain("Bash");
    expect(agentOptions.allowedTools).toContain("Read");
    expect(agentOptions.allowedTools).toContain("mcp__memory__memory_search");
    expect(agentOptions.hooks.PreToolUse).toHaveLength(6);
    expect(agentOptions.hooks.PreToolUse![0].matcher).toBe("Bash");
    expect(agentOptions.hooks.PreToolUse![1].matcher).toBe("Read");
    expect(agentOptions.hooks.PreToolUse![2].matcher).toBe("Write");
    expect(agentOptions.hooks.PreToolUse![3].matcher).toBe("Edit");
    expect(agentOptions.hooks.PreToolUse![4].matcher).toBe("Glob");
    expect(agentOptions.hooks.PreToolUse![5].matcher).toBe("Grep");
  });

  it("workspace bootstrapping is idempotent (safe to call twice)", async () => {
    const config = makeConfig(workspaceDir, dataDir);

    await ensureWorkspace(config);

    // Write custom content to AGENTS.md
    const customContent = "# Custom Agent Instructions";
    fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), customContent);

    // Call ensureWorkspace again -- should not overwrite
    await ensureWorkspace(config);

    const content = fs.readFileSync(
      path.join(workspaceDir, "AGENTS.md"),
      "utf-8",
    );
    expect(content).toBe(customContent);
  });

  it("memory files gracefully handle missing optional files", async () => {
    const config = makeConfig(workspaceDir, dataDir);

    await ensureWorkspace(config);

    // Delete one optional file
    fs.unlinkSync(path.join(workspaceDir, "HEARTBEAT.md"));

    // Read without heartbeat -- should work fine
    const content = await readMemoryFiles(workspaceDir);
    expect(content.length).toBeGreaterThan(0);

    // Read with heartbeat flag -- should still work (missing file is skipped)
    const contentWithHb = await readMemoryFiles(workspaceDir, {
      includeHeartbeat: true,
    });
    expect(contentWithHb.length).toBeGreaterThan(0);
  });

  it("agent options include model when config specifies one", async () => {
    const config = makeConfig(workspaceDir, dataDir, {
      agent: { model: "claude-3-opus-20240229", maxTurns: 100 },
    } as Partial<Config>);

    await ensureWorkspace(config);
    const memoryContent = await readMemoryFiles(workspaceDir);
    const agentOptions = buildAgentOptions(config, workspaceDir, memoryContent, {});

    expect(agentOptions.model).toBe("claude-3-opus-20240229");
    expect(agentOptions.maxTurns).toBe(100);
  });
});

// ===========================================================================
// Test 2: Security hook blocks dangerous commands in full pipeline
// ===========================================================================

describe("Integration: Security hook blocks dangerous commands in full pipeline", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let dataDir: string;
  let config: Config;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "integration-security-"));
    workspaceDir = path.join(tmpDir, "workspace");
    dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(workspaceDir, { recursive: true });
    config = makeConfig(workspaceDir, dataDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows safe commands within the workspace", async () => {
    const result = await bashSecurityHook(
      {
        tool_name: "Bash",
        tool_input: { command: `ls ${workspaceDir}` },
      },
      "tool-1",
      { workspaceDir, config },
    );

    // Should return empty object (allow)
    expect(result).toEqual({});
  });

  it("blocks commands not on the allowlist", async () => {
    const result = await bashSecurityHook(
      {
        tool_name: "Bash",
        tool_input: { command: "reboot" },
      },
      "tool-2",
      { workspaceDir, config },
    );

    expect(result).toHaveProperty("decision", "block");
    expect((result as { reason: string }).reason).toContain("reboot");
  });

  it("blocks rm -rf with dangerous patterns", async () => {
    const result = await bashSecurityHook(
      {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /*" },
      },
      "tool-3",
      { workspaceDir, config },
    );

    expect(result).toHaveProperty("decision", "block");
  });

  it("blocks file operations outside the workspace", async () => {
    const result = await bashSecurityHook(
      {
        tool_name: "Bash",
        tool_input: { command: "cat /etc/shadow" },
      },
      "tool-4",
      { workspaceDir, config },
    );

    expect(result).toHaveProperty("decision", "block");
    expect((result as { reason: string }).reason).toContain("outside");
  });

  it("allows piped commands that are all on the allowlist", async () => {
    const result = await bashSecurityHook(
      {
        tool_name: "Bash",
        tool_input: { command: "echo hello | grep hello" },
      },
      "tool-5",
      { workspaceDir, config },
    );

    expect(result).toEqual({});
  });

  it("blocks chained commands when one is not on the allowlist", async () => {
    const result = await bashSecurityHook(
      {
        tool_name: "Bash",
        tool_input: { command: "ls && reboot" },
      },
      "tool-6",
      { workspaceDir, config },
    );

    expect(result).toHaveProperty("decision", "block");
  });

  it("passes through non-Bash tool calls", async () => {
    const result = await bashSecurityHook(
      {
        tool_name: "Read",
        tool_input: { file_path: "/etc/passwd" },
      },
      "tool-7",
      { workspaceDir, config },
    );

    // Non-Bash tool calls are passed through unchanged
    expect(result).toEqual({});
  });

  it("blocks kill of PID 1 in the full security pipeline", async () => {
    const result = await bashSecurityHook(
      {
        tool_name: "Bash",
        tool_input: { command: "kill -9 1" },
      },
      "tool-8",
      { workspaceDir, config },
    );

    expect(result).toHaveProperty("decision", "block");
    expect((result as { reason: string }).reason).toContain("PID 1");
  });

  it("works when invoked through built agent options hook", async () => {
    // Build real agent options with the security hook wired in
    const memoryContent = "test memory";
    const agentOptions = buildAgentOptions(config, workspaceDir, memoryContent, {});

    // The hook should be wired into PreToolUse
    const hooks = agentOptions.hooks.PreToolUse!;
    expect(hooks).toHaveLength(6);
    expect(hooks[0].matcher).toBe("Bash");

    // Invoke the hook directly
    const hookFn = hooks[0].hooks[0];
    const blockResult = await hookFn(
      { tool_name: "Bash", tool_input: { command: "reboot" } },
      "tool-9",
    );
    expect(blockResult).toHaveProperty("decision", "block");

    const allowResult = await hookFn(
      { tool_name: "Bash", tool_input: { command: "echo hello" } },
      "tool-10",
    );
    expect(allowResult).toEqual({});
  });
});

// ===========================================================================
// Test 3: Hybrid search returns results for indexed content
// ===========================================================================

describe("Integration: Hybrid search returns results for indexed content", () => {
  const DIMS = 64;
  let store: VectorStore;
  let embedder: EmbeddingProvider;
  let indexer: Indexer;
  let tmpDir: string;

  beforeEach(() => {
    store = createVectorStore(":memory:", DIMS);
    embedder = createMockEmbeddingProvider(DIMS);
    indexer = createIndexer(store, embedder);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "integration-search-"));
  });

  afterEach(async () => {
    indexer?.close();
    store?.close();
    await embedder?.close();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function createTempFile(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  it("indexes files and returns search results through full pipeline", async () => {
    // Step 1: Create files with distinct content
    const fileA = createTempFile(
      "config-guide.md",
      "Configuration guide for the personal assistant.\nSet up workspace directory.\nConfigure security settings and allowed commands.",
    );
    const fileB = createTempFile(
      "api-docs.md",
      "API documentation for the REST endpoints.\nAuthentication uses bearer tokens.\nRate limiting is configured per-user.",
    );
    const fileC = createTempFile(
      "deployment.md",
      "Deployment instructions for production.\nUse Docker containers.\nSet environment variables before starting.",
    );

    // Step 2: Index all files via the indexer
    await indexer.syncFiles([fileA, fileB, fileC]);

    // Verify files are tracked
    expect(store.getFileHash(fileA)).not.toBeNull();
    expect(store.getFileHash(fileB)).not.toBeNull();
    expect(store.getFileHash(fileC)).not.toBeNull();

    // Step 3: Perform a hybrid search
    const searchConfig: HybridSearchConfig = {
      vectorWeight: 0.7,
      keywordWeight: 0.3,
      minScore: 0.0, // low threshold to get results
      maxResults: 6,
    };

    const results = await hybridSearch(
      "configuration workspace security",
      store,
      embedder,
      searchConfig,
    );

    // Should get results back
    expect(results.length).toBeGreaterThan(0);

    // Results should have valid structure
    for (const result of results) {
      expect(result).toHaveProperty("path");
      expect(result).toHaveProperty("snippet");
      expect(result).toHaveProperty("startLine");
      expect(result).toHaveProperty("endLine");
      expect(result).toHaveProperty("score");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }

    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("re-indexes files when content changes and returns updated results", async () => {
    const file = createTempFile(
      "notes.md",
      "Original content about machine learning algorithms.",
    );

    await indexer.syncFiles([file]);

    // Search for original content -- should find the keyword
    const originalResults = await hybridSearch(
      "machine learning",
      store,
      embedder,
      { vectorWeight: 0.7, keywordWeight: 0.3, minScore: 0, maxResults: 6 },
    );
    expect(originalResults.length).toBeGreaterThan(0);
    expect(originalResults[0].snippet).toContain("machine learning");

    // Update file content
    fs.writeFileSync(
      file,
      "Updated content about web development frameworks and React.",
      "utf-8",
    );

    // Re-index
    await indexer.syncFiles([file]);

    // Search for new content
    const newResults = await hybridSearch(
      "web development React",
      store,
      embedder,
      { vectorWeight: 0.7, keywordWeight: 0.3, minScore: 0, maxResults: 6 },
    );
    expect(newResults.length).toBeGreaterThan(0);
    expect(newResults[0].snippet).toContain("web development");

    // Old content should no longer appear in keyword search
    const oldKeywordResults = store.searchKeyword("machine learning", 10);
    expect(oldKeywordResults).toHaveLength(0);
  });

  it("removes file from index when removed from sync list", async () => {
    const fileA = createTempFile("keep.md", "Keepable content about databases.");
    const fileB = createTempFile("remove.md", "Removable content about testing.");

    await indexer.syncFiles([fileA, fileB]);

    // Both should be searchable
    const beforeResults = store.searchKeyword("databases", 10);
    expect(beforeResults.length).toBeGreaterThan(0);

    // Sync with only fileA
    await indexer.syncFiles([fileA]);

    // fileB should be completely gone
    expect(store.getFileHash(fileB)).toBeNull();
    const removedResults = store.searchKeyword("Removable testing", 10);
    expect(removedResults).toHaveLength(0);

    // fileA should still be there
    expect(store.getFileHash(fileA)).not.toBeNull();
  });

  it("dirty flag triggers sync only when marked dirty", async () => {
    const file = createTempFile("lazy.md", "Lazy indexed content.");

    // Not dirty -- syncIfDirty should be a no-op
    await indexer.syncIfDirty([file]);
    expect(store.getFileHash(file)).toBeNull();

    // Mark dirty and sync
    indexer.markDirty();
    expect(indexer.isDirty()).toBe(true);
    await indexer.syncIfDirty([file]);
    expect(indexer.isDirty()).toBe(false);
    expect(store.getFileHash(file)).not.toBeNull();
  });
});

// ===========================================================================
// Test 4: Queue processes messages in order
// ===========================================================================

describe("Integration: Queue processes messages in order", () => {
  let config: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    config = makeConfig("/tmp/workspace", "/tmp/data", {
      gateway: { maxQueueSize: 10 },
    } as Partial<Config>);
  });

  it("enqueues multiple messages and reports correct queue size", () => {
    const queue = createMessageQueue(config);

    expect(queue.size()).toBe(0);

    const messages: AdapterMessage[] = [
      { source: "telegram", sourceId: "user1", text: "first message" },
      { source: "slack", sourceId: "user2", text: "second message" },
      { source: "telegram", sourceId: "user3", text: "third message" },
    ];

    for (const msg of messages) {
      const result = queue.enqueue(msg);
      expect(result).toEqual({ accepted: true });
    }

    expect(queue.size()).toBe(3);
  });

  it("rejects messages when queue is full", () => {
    const smallConfig = makeConfig("/tmp/workspace", "/tmp/data", {
      gateway: { maxQueueSize: 2 },
    } as Partial<Config>);
    const queue = createMessageQueue(smallConfig);

    queue.enqueue({ source: "telegram", sourceId: "u1", text: "msg1" });
    queue.enqueue({ source: "telegram", sourceId: "u2", text: "msg2" });

    const result = queue.enqueue({ source: "telegram", sourceId: "u3", text: "msg3" });
    expect(result).toEqual({ accepted: false, reason: "Queue full" });
    expect(queue.size()).toBe(2);
  });

  it("router delivers responses to the correct adapter", async () => {
    const router = createRouter();
    const telegram = makeAdapter("telegram");
    const slack = makeAdapter("slack");
    router.register(telegram);
    router.register(slack);

    // Route to telegram
    await router.route({
      source: "telegram",
      sourceId: "123",
      text: "telegram response",
    });

    // Route to slack
    await router.route({
      source: "slack",
      sourceId: "456",
      text: "slack response",
    });

    expect(telegram.sendResponse).toHaveBeenCalledTimes(1);
    expect(telegram.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ text: "telegram response" }),
    );
    expect(slack.sendResponse).toHaveBeenCalledTimes(1);
    expect(slack.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ text: "slack response" }),
    );
  });

  it("queue + router work together in processLoop", async () => {
    // runAgentTurn is mocked at the top level via vi.mock
    vi.mocked(runAgentTurn).mockImplementation(async (message: string) => {
      return { response: `reply to: ${message}`, messages: [] };
    });

    const router = createRouter();
    const adapter = makeAdapter("telegram");
    router.register(adapter);

    const queue = createMessageQueue(config);

    // Enqueue messages
    queue.enqueue({ source: "telegram", sourceId: "u1", text: "hello" });
    queue.enqueue({ source: "telegram", sourceId: "u1", text: "world" });

    const agentOptions = buildAgentOptions(
      config,
      "/tmp/workspace",
      "test memory",
      {},
    );

    // Start loop in background
    const loopDone = queue.processLoop(agentOptions, config, router);

    // Wait for both messages to be processed
    await vi.waitFor(() => {
      expect(adapter.sendResponse).toHaveBeenCalledTimes(2);
    });

    queue.stop();
    await loopDone;

    // Verify responses were routed back
    expect(adapter.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ text: "reply to: hello" }),
    );
    expect(adapter.sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ text: "reply to: world" }),
    );
  });
});

// ===========================================================================
// Test 5: System events flow from enqueue -> heartbeat -> prompt resolution
// ===========================================================================

describe("Integration: System events flow from enqueue -> heartbeat -> prompt resolution", () => {
  beforeEach(() => {
    clearSystemEvents();
  });

  afterEach(() => {
    clearSystemEvents();
  });

  it("enqueued system events are resolved to heartbeat prompt", () => {
    // Step 1: Enqueue system events
    enqueueSystemEvent("System booted up", "system");

    // Step 2: Drain events
    const events = drainSystemEvents();

    // Step 3: Resolve heartbeat prompt
    const prompt = resolveHeartbeatPrompt(events);

    // Standard heartbeat prompt (no exec or cron events)
    expect(prompt).toContain("HEARTBEAT.md");
    expect(prompt).toContain("current time is");
  });

  it("exec events take highest priority in prompt resolution", () => {
    // Enqueue a mix of event types
    enqueueSystemEvent("Background build completed", "exec");
    enqueueSystemEvent("Reminder: deploy release", "cron");
    enqueueSystemEvent("System health check", "system");

    const events = drainSystemEvents();

    expect(events).toHaveLength(3);

    const prompt = resolveHeartbeatPrompt(events);

    // exec events have highest priority
    expect(prompt).toContain("background command completed");
    expect(prompt).toContain("Background build completed");
  });

  it("cron events take second priority when no exec events", () => {
    enqueueSystemEvent("Reminder: deploy release", "cron");
    enqueueSystemEvent("System health check", "system");

    const events = drainSystemEvents();
    const prompt = resolveHeartbeatPrompt(events);

    expect(prompt).toContain("scheduled reminder fired");
    expect(prompt).toContain("deploy release");
  });

  it("standard heartbeat prompt used when only system events", () => {
    enqueueSystemEvent("System initialized", "system");

    const events = drainSystemEvents();
    const prompt = resolveHeartbeatPrompt(events);

    // No exec or cron events, so standard heartbeat prompt
    expect(prompt).toContain("HEARTBEAT.md");
    expect(prompt).toContain("HEARTBEAT_OK");
  });

  it("drain clears the queue (subsequent drain returns empty)", () => {
    enqueueSystemEvent("event one", "system");
    enqueueSystemEvent("event two", "exec");

    const firstDrain = drainSystemEvents();
    expect(firstDrain).toHaveLength(2);

    const secondDrain = drainSystemEvents();
    expect(secondDrain).toHaveLength(0);
  });

  it("events maintain order and have timestamps", () => {
    enqueueSystemEvent("first", "system");
    enqueueSystemEvent("second", "cron");
    enqueueSystemEvent("third", "exec");

    const events = drainSystemEvents();

    expect(events).toHaveLength(3);
    expect(events[0].text).toBe("first");
    expect(events[0].type).toBe("system");
    expect(events[1].text).toBe("second");
    expect(events[1].type).toBe("cron");
    expect(events[2].text).toBe("third");
    expect(events[2].type).toBe("exec");

    for (const event of events) {
      expect(event.timestamp).toBeDefined();
      // Should be valid ISO-8601
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }
  });

  it("event queue caps at 20 events (oldest removed first)", () => {
    // Enqueue 25 events
    for (let i = 0; i < 25; i++) {
      enqueueSystemEvent(`event-${i}`, "system");
    }

    const events = drainSystemEvents();

    expect(events).toHaveLength(20);
    // Oldest 5 should have been removed
    expect(events[0].text).toBe("event-5");
    expect(events[19].text).toBe("event-24");
  });

  it("full flow: enqueue events -> drain -> resolve prompt -> verify content", () => {
    // Simulate a real heartbeat cycle

    // 1. A cron job fires and a background command completes
    enqueueSystemEvent("Daily backup completed with 0 errors", "exec");
    enqueueSystemEvent("Check project deadlines", "cron");

    // 2. Drain events for the heartbeat
    const events = drainSystemEvents();
    expect(events).toHaveLength(2);

    // 3. Resolve the prompt
    const prompt = resolveHeartbeatPrompt(events);

    // exec event takes priority
    expect(prompt).toContain("Daily backup completed");
    expect(prompt).not.toContain("deadlines"); // cron is lower priority

    // 4. Queue should be empty now
    const remaining = drainSystemEvents();
    expect(remaining).toHaveLength(0);

    // 5. Empty events -> standard heartbeat
    const standardPrompt = resolveHeartbeatPrompt([]);
    expect(standardPrompt).toContain("HEARTBEAT.md");
  });
});

// ===========================================================================
// Test 6: Full pipeline with config loading from disk
// ===========================================================================

describe("Integration: Full pipeline from settings.json on disk", () => {
  let tmpDir: string;
  let configDir: string;
  let workspaceDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "integration-full-"));
    configDir = path.join(tmpDir, "config");
    workspaceDir = path.join(tmpDir, "workspace");
    dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("config with custom security settings affects bash hook behavior", async () => {
    // Create a restrictive config with only 'ls' and 'echo' allowed
    const settings = {
      security: {
        workspace: workspaceDir,
        dataDir,
        allowedCommands: ["ls", "echo"],
        commandsNeedingExtraValidation: [],
        additionalReadDirs: [],
        additionalWriteDirs: [],
      },
    };
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify(settings),
    );

    const config = loadConfig(configDir);
    await ensureWorkspace(config);

    // 'ls' should be allowed
    const lsResult = await bashSecurityHook(
      { tool_name: "Bash", tool_input: { command: "ls" } },
      "t1",
      { workspaceDir: config.security.workspace, config },
    );
    expect(lsResult).toEqual({});

    // 'cat' should be blocked (not in custom allowlist)
    const catResult = await bashSecurityHook(
      { tool_name: "Bash", tool_input: { command: "cat README.md" } },
      "t2",
      { workspaceDir: config.security.workspace, config },
    );
    expect(catResult).toHaveProperty("decision", "block");
  });
});
