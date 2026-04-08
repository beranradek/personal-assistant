/**
 * Daily Reflection — Automated Memory Curation
 * =============================================
 *
 * Reads yesterday's daily JSONL audit log, extracts key decisions/lessons/facts
 * via the Anthropic API, and writes the output to
 * {workspaceDir}/memory/reflection-YYYY-MM-DD.md with YAML frontmatter.
 *
 * The pipeline is:
 *   1. Read yesterday's daily/{date}.jsonl using readAuditEntries()
 *   2. Filter to interaction entries (skip tool_call noise)
 *   3. Format as readable conversation text
 *   4. Call Anthropic API with the REFLECTION_PROMPT template
 *   5. Parse categories from the LLM response (decision, lesson, fact, project-update)
 *   6. Write output to memory/reflection-{date}.md (idempotent — skips if exists)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditEntries } from "./daily-log.js";
import { createLogger } from "../core/logger.js";
import type { AuditEntry, Config } from "../core/types.js";

const log = createLogger("daily-reflection");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the reflection curation system prompt template */
export const REFLECTION_PROMPT_PATH = path.resolve(
  __dirname,
  "..",
  "templates",
  "REFLECTION_PROMPT.md",
);

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Get yesterday's date string in YYYY-MM-DD format */
export function getYesterdayDate(now?: Date): string {
  const d = now ?? new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Format interaction-type audit entries as readable conversation text for the LLM */
export function formatInteractionsForLLM(entries: AuditEntry[]): string {
  return entries
    .map((e) => {
      const parts: string[] = [`[${e.timestamp}]`];
      if (e.userMessage) parts.push(`User: ${e.userMessage}`);
      if (e.assistantResponse) parts.push(`Assistant: ${e.assistantResponse}`);
      return parts.join("\n");
    })
    .join("\n\n---\n\n");
}

/**
 * Parse LLM response markdown sections into category names.
 * Returns the categories present in the response.
 */
export function parseCategories(response: string): string[] {
  const sectionToCat: Array<[string, string]> = [
    ["## Decisions", "decision"],
    ["## Lessons Learned", "lesson"],
    ["## Facts", "fact"],
    ["## Project Updates", "project-update"],
  ];
  return sectionToCat
    .filter(([header]) => response.includes(header))
    .map(([, cat]) => cat);
}

// ---------------------------------------------------------------------------
// Anthropic API call
// ---------------------------------------------------------------------------

/**
 * Call the Anthropic Messages API for daily reflection.
 * Uses a system prompt from the REFLECTION_PROMPT template
 * and passes the conversation text as user content.
 */
export async function callAnthropicForReflection(
  systemPrompt: string,
  conversationText: string,
  model: string,
): Promise<string> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — cannot call Anthropic API");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Here is the daily conversation log for reflection:\n\n<log>\n${conversationText}\n</log>`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  return text;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run the daily reflection pipeline for a given date (defaults to yesterday).
 *
 * Reads the specified date's JSONL audit log, extracts interaction entries,
 * calls the Anthropic API with a curation prompt, and writes
 * {workspaceDir}/memory/reflection-{date}.md.
 *
 * Idempotent — skips if the reflection file already exists for that date.
 * Non-fatal — errors are logged but never thrown to avoid blocking the daemon.
 *
 * The memory watcher will automatically pick up the new file for indexing.
 *
 * @param config       - App config
 * @param workspaceDir - Workspace directory
 * @param targetDate   - Optional date string (YYYY-MM-DD). Defaults to yesterday.
 */
export async function runDailyReflection(
  config: Config,
  workspaceDir: string,
  targetDate?: string,
): Promise<void> {
  if (!config.reflection.enabled) {
    log.debug("Daily reflection disabled — skipping");
    return;
  }

  const date = targetDate ?? getYesterdayDate();
  const outputPath = path.join(workspaceDir, "memory", `reflection-${date}.md`);

  // Idempotency check — skip if already processed today
  try {
    await fs.access(outputPath);
    log.info({ date }, "Reflection file already exists — skipping");
    return;
  } catch {
    // File doesn't exist — proceed
  }

  // Read and filter entries from yesterday's daily log
  const entries = await readAuditEntries(workspaceDir, date);
  const interactions = entries.filter((e) => e.type === "interaction");

  if (interactions.length === 0) {
    log.info(
      { date },
      "No interaction entries in yesterday's log — skipping reflection",
    );
    return;
  }

  // Cap to configured max entries (take most recent)
  const maxEntries = config.reflection.maxDailyLogEntries;
  const toProcess =
    interactions.length > maxEntries
      ? interactions.slice(-maxEntries)
      : interactions;

  // Format entries for the LLM
  const conversationText = formatInteractionsForLLM(toProcess);

  // Load the reflection curation prompt template
  let systemPrompt: string;
  try {
    systemPrompt = await fs.readFile(REFLECTION_PROMPT_PATH, "utf-8");
  } catch (err) {
    log.error({ err }, "Failed to read REFLECTION_PROMPT template — skipping");
    return;
  }

  // Call Anthropic API
  let llmResponse: string;
  try {
    llmResponse = await callAnthropicForReflection(
      systemPrompt,
      conversationText,
      config.session.summarizationModel,
    );
  } catch (err) {
    log.error({ err, date }, "LLM call failed during daily reflection — skipping");
    return;
  }

  // Skip if nothing to extract (LLM returned sentinel or empty)
  const trimmed = llmResponse.trim();
  if (!trimmed || trimmed === "(nothing to extract)") {
    log.info({ date }, "LLM found nothing to extract — skipping");
    return;
  }

  // Parse categories for YAML frontmatter
  const categories = parseCategories(trimmed);

  const categoryLines =
    categories.length > 0
      ? `categories:\n${categories.map((c) => `  - ${c}`).join("\n")}`
      : "categories: []";

  const fileContent = [
    "---",
    `date: ${date}`,
    `entry_count: ${toProcess.length}`,
    categoryLines,
    "---",
    "",
    trimmed,
    "",
  ].join("\n");

  // Ensure memory/ dir exists
  await fs.mkdir(path.join(workspaceDir, "memory"), {
    recursive: true,
    mode: 0o700,
  });

  // Write atomically — skip silently if another process wrote it concurrently
  try {
    await fs.writeFile(outputPath, fileContent, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    log.info(
      { date, categories, entryCount: toProcess.length },
      "Daily reflection written",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      log.info({ date }, "Reflection file created concurrently — skipping");
    } else {
      log.error({ err, date }, "Failed to write reflection file");
    }
  }
}
