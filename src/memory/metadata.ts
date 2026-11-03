import { parseDocument } from "yaml";
import { z } from "zod";

export interface MemoryMetadata {
  type?: string;
  title?: string;
  description?: string;
  tags?: string[];
  lastReviewed?: string;
}

export interface MemorySearchFilters {
  type?: string;
  /** Every requested tag must be present (case-insensitive). */
  tags?: string[];
}

export const MemorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(512),
  maxResults: z.number().int().positive().max(100).optional(),
  type: z.string().trim().min(1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
}).strict();

export interface MemoryMetadataIssue {
  code: "invalid-frontmatter" | "invalid-type" | "invalid-title" | "invalid-tags";
  message: string;
}

export interface ParsedMemoryMetadata {
  metadata: MemoryMetadata;
  body: string;
  issues: MemoryMetadataIssue[];
}

const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Parse the optional YAML frontmatter used by OKF-lite Markdown pages. */
export function parseMemoryMetadata(content: string): ParsedMemoryMetadata {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) return { metadata: {}, body: content, issues: [] };

  const document = parseDocument(match[1] ?? "");
  if (document.errors.length > 0) {
    return {
      metadata: {},
      body: content.slice(match[0].length),
      issues: [{ code: "invalid-frontmatter", message: document.errors[0]!.message }],
    };
  }

  const raw = document.toJS();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      metadata: {},
      body: content.slice(match[0].length),
      issues: [{ code: "invalid-frontmatter", message: "Frontmatter must be a YAML mapping." }],
    };
  }

  const values = raw as Record<string, unknown>;
  const metadata: MemoryMetadata = {};
  const issues: MemoryMetadataIssue[] = [];

  for (const [key, target] of [["type", "type"], ["title", "title"], ["description", "description"], ["last_reviewed", "lastReviewed"]] as const) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value === "string" && value.trim()) {
      metadata[target] = value.trim();
    } else if (key === "type") {
      issues.push({ code: "invalid-type", message: "Frontmatter field 'type' must be a non-empty string." });
    } else if (key === "title") {
      issues.push({ code: "invalid-title", message: "Frontmatter field 'title' must be a non-empty string." });
    }
  }

  if (values.tags !== undefined) {
    if (!Array.isArray(values.tags) || values.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
      issues.push({ code: "invalid-tags", message: "Frontmatter field 'tags' must be an array of non-empty strings." });
    }
    const tags = Array.isArray(values.tags)
      ? values.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())).map((tag) => tag.trim())
      : [];
    if (tags.length > 0) metadata.tags = tags;
  }

  return { metadata, body: content.slice(match[0].length), issues };
}

export function matchesMemoryFilters(
  metadata: MemoryMetadata,
  filters: MemorySearchFilters = {},
): boolean {
  if (filters.type && metadata.type?.toLocaleLowerCase() !== filters.type.toLocaleLowerCase()) {
    return false;
  }

  if (filters.tags?.length) {
    const pageTags = new Set((metadata.tags ?? []).map((tag) => tag.toLocaleLowerCase()));
    return filters.tags.every((tag) => pageTags.has(tag.toLocaleLowerCase()));
  }

  return true;
}
