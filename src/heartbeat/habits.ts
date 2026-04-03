import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Pillar {
  id: string;
  label: string;
  type: "auto" | "manual";
  detectionCommand?: string;
  description: string;
}

export interface HabitsData {
  pillars: Pillar[];
  checklist: Record<string, boolean>;
  historySection: string;
}

// ---------------------------------------------------------------------------
// Safe command whitelist for auto-detection
// ---------------------------------------------------------------------------

const SAFE_COMMANDS = new Set(["git", "wc", "ls", "cat", "grep", "date", "stat"]);

/**
 * Parse a detection command string into binary + args.
 * Returns null if the binary is not in the safe whitelist.
 */
export function parseDetectionCommand(
  cmd: string,
): { binary: string; args: string[] } | null {
  const parts = cmd.trim().split(/\s+/);
  const binary = parts[0];
  if (!binary || !SAFE_COMMANDS.has(binary)) return null;
  return { binary, args: parts.slice(1) };
}

// ---------------------------------------------------------------------------
// HABITS.md parsing helpers
// ---------------------------------------------------------------------------

const HABITS_FILE = "HABITS.md";

/**
 * Extract a field value from a YAML-lite block.
 * Handles both quoted ("value") and unquoted (value) formats.
 */
function extractYamlField(text: string, field: string): string | undefined {
  // Quoted: field: "value"
  const quotedMatch = text.match(new RegExp(`${field}:\\s+"([^"]+)"`));
  if (quotedMatch) return quotedMatch[1];
  // Unquoted: field: value
  const unquotedMatch = text.match(new RegExp(`${field}:\\s+([^\\n]+)`));
  return unquotedMatch?.[1]?.trim();
}

/**
 * Parse the YAML frontmatter pillars block into Pillar objects.
 */
function parsePillars(pillarsYaml: string): Pillar[] {
  // Split on lines that start a new pillar entry ("  - id:")
  const blocks = pillarsYaml.split(/(?=\n\s*-\s+id:)/);
  return blocks
    .filter((b) => /id:/.test(b))
    .map((block) => {
      const id = extractYamlField(block, "id") ?? "";
      const label = extractYamlField(block, "label") ?? "";
      const typeStr = extractYamlField(block, "type") ?? "manual";
      const detectionCommand = extractYamlField(block, "detection_command");
      const description = extractYamlField(block, "description") ?? "";
      return {
        id,
        label,
        type: typeStr === "auto" ? ("auto" as const) : ("manual" as const),
        ...(detectionCommand ? { detectionCommand } : {}),
        description,
      };
    })
    .filter((p) => p.id !== "");
}

/**
 * Parse the checklist section (lines like "- [ ] Label" or "- [x] Label").
 * Returns a map of label -> done.
 */
function parseChecklist(checklistSection: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  const lines = checklistSection.split("\n");
  for (const line of lines) {
    const match = line.match(/^-\s+\[( |x)\]\s+(.+)$/i);
    if (match) {
      const done = match[1].toLowerCase() === "x";
      const label = match[2].trim();
      result[label] = done;
    }
  }
  return result;
}

/**
 * Build a checklist section string from pillars (all unchecked).
 */
function buildChecklist(pillars: Pillar[]): string {
  return pillars.map((p) => `- [ ] ${p.label}`).join("\n");
}

/**
 * Get today's date string in YYYY-MM-DD format.
 */
function todayString(now?: Date): string {
  return (now ?? new Date()).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load habits data from HABITS.md in the workspace.
 * Returns pillars from frontmatter, current checklist, and history section.
 */
export async function loadHabits(workspacePath: string): Promise<HabitsData | null> {
  const filePath = path.join(workspacePath, HABITS_FILE);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null; // HABITS.md doesn't exist yet
  }

  // Extract frontmatter (between first --- pair)
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1];

  // Extract pillars section from frontmatter
  const pillarsMatch = frontmatter.match(/pillars:\n([\s\S]*?)(?=\n\w|\s*$)/);
  const pillars = pillarsMatch ? parsePillars(pillarsMatch[1]) : [];

  // Extract "Today's Habits" section
  const todayMatch = content.match(
    /## Today's Habits[^\n]*\n([\s\S]*?)(?=\n## |$)/,
  );
  const checklistSection = todayMatch ? todayMatch[1].trim() : "";
  const checklist = parseChecklist(checklistSection);

  // Extract History section
  const historyMatch = content.match(/## History\n([\s\S]*)$/);
  const historySection = historyMatch ? historyMatch[1] : "";

  return { pillars, checklist, historySection };
}

/**
 * Check auto-detectable pillars by running their detection commands.
 * Only commands with a binary in the safe whitelist are executed.
 * Returns a map of pillar ID -> done (true if command produced non-empty output).
 *
 * Note: This does NOT update HABITS.md. Call markHabit() separately.
 */
export async function checkAutoHabits(
  workspacePath: string,
  pillars: Pillar[],
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};

  for (const pillar of pillars) {
    if (pillar.type !== "auto" || !pillar.detectionCommand) continue;

    const parsed = parseDetectionCommand(pillar.detectionCommand);
    if (!parsed) {
      // Command not in safe whitelist — skip silently
      results[pillar.id] = false;
      continue;
    }

    try {
      const { stdout } = await execFileAsync(parsed.binary, parsed.args, {
        cwd: workspacePath,
        timeout: 5000,
      });
      results[pillar.id] = stdout.trim().length > 0;
    } catch {
      results[pillar.id] = false;
    }
  }

  return results;
}

/**
 * Archive yesterday's checklist to the History section and reset
 * the "Today's Habits" section with an unchecked checklist for today.
 * Idempotent — if today's date already appears in the header, does nothing.
 */
export async function resetDaily(workspacePath: string, now?: Date): Promise<void> {
  const filePath = path.join(workspacePath, HABITS_FILE);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return; // HABITS.md doesn't exist — nothing to do
  }

  const today = todayString(now);

  // Check if today's date is already in the header — idempotent guard
  const todayHeaderMatch = content.match(/## Today's Habits — (.+)/);
  if (todayHeaderMatch && todayHeaderMatch[1].trim() === today) {
    return; // Already reset for today
  }

  // Extract frontmatter
  const fmMatch = content.match(/^(---\n[\s\S]*?\n---)/);
  const frontmatter = fmMatch ? fmMatch[1] : "";

  // Extract pillars for building new checklist
  const pillarsMatch = content.match(/pillars:\n([\s\S]*?)(?=\n\w|\s*---)/);
  const pillars = pillarsMatch ? parsePillars(pillarsMatch[1]) : [];

  // Extract old "Today's Habits" section to archive
  const oldTodayMatch = content.match(
    /## Today's Habits — ([^\n]*)\n([\s\S]*?)(?=\n## |$)/,
  );

  // Extract existing History section content
  const historyMatch = content.match(/## History\n([\s\S]*)$/);
  const existingHistory = historyMatch ? historyMatch[1] : "";

  // Build archive entry from old checklist (if it was a real date, not a placeholder)
  let newHistory = existingHistory;
  if (
    oldTodayMatch &&
    oldTodayMatch[1].trim() !== "{{DATE}}" &&
    oldTodayMatch[2].trim()
  ) {
    const oldDate = oldTodayMatch[1].trim();
    const oldChecklist = oldTodayMatch[2].trim();
    newHistory = `### ${oldDate}\n${oldChecklist}\n\n${existingHistory}`;
  }

  // Build fresh content
  const freshChecklist = buildChecklist(pillars);
  const newContent = [
    frontmatter,
    "",
    `## Today's Habits — ${today}`,
    "",
    freshChecklist,
    "",
    "## History",
    "",
    newHistory,
  ]
    .join("\n")
    .trimEnd();

  await fs.writeFile(filePath, newContent + "\n", { mode: 0o600 });
}

/**
 * Mark a habit pillar as done or undone in the HABITS.md checklist.
 * Matches by pillar label (case-insensitive).
 */
export async function markHabit(
  workspacePath: string,
  pillarLabel: string,
  done: boolean,
): Promise<void> {
  const filePath = path.join(workspacePath, HABITS_FILE);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return; // HABITS.md doesn't exist
  }

  const marker = done ? "x" : " ";
  const escapedLabel = pillarLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Replace the checklist entry for this pillar (in Today's section only)
  const updated = content.replace(
    new RegExp(`^(- \\[)[ x](\\] ${escapedLabel})$`, "im"),
    `$1${marker}$2`,
  );

  if (updated === content) return; // No change — label not found

  await fs.writeFile(filePath, updated, { mode: 0o600 });
}

/**
 * Generate a compact status string for the heartbeat prompt.
 * Example: "[x] Code Commit  [ ] Exercise  [ ] Reading"
 */
export function formatHabitStatus(
  checklist: Record<string, boolean>,
  pillars: Pillar[],
): string {
  return pillars
    .map((p) => {
      const done = checklist[p.label] === true;
      return `[${done ? "x" : " "}] ${p.label}`;
    })
    .join("  ");
}
