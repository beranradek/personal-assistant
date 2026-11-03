import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseMemoryMetadata } from "./metadata.js";

export interface MemoryLintIssue {
  code: "invalid-frontmatter" | "invalid-type" | "invalid-title" | "invalid-tags" | "broken-link" | "broken-anchor" | "duplicate-entity";
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface MemoryLintResult {
  filesScanned: number;
  issues: MemoryLintIssue[];
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectMarkdownFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(entryPath);
  }
  return result;
}

function headingIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  const seen = new Map<string, number>();
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  for (const line of withoutFences.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = (match[1] ?? "")
      .trim()
      .toLocaleLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

function isExternalLink(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function linksIn(markdown: string): string[] {
  const result: string[] = [];
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  const pattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  for (const match of withoutFences.matchAll(pattern)) {
    const target = (match[1] ?? "").trim().split(/\s+/, 1)[0];
    if (target) result.push(target);
  }
  return result;
}

/** Lint one workspace's `memory/` graph without following symlinks. */
export async function lintMemoryKnowledgeBase(workspaceDir: string): Promise<MemoryLintResult> {
  const memoryDir = path.join(workspaceDir, "memory");
  const files = await collectMarkdownFiles(memoryDir);
  const issues: MemoryLintIssue[] = [];
  const contentByPath = new Map<string, string>();
  const headingsByPath = new Map<string, Set<string>>();
  const entities = new Map<string, string>();

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    contentByPath.set(filePath, content);
    headingsByPath.set(filePath, headingIds(content));
    const parsed = parseMemoryMetadata(content);
    for (const issue of parsed.issues) {
      issues.push({ ...issue, severity: "error", path: filePath });
    }

    if (parsed.metadata.type && parsed.metadata.title) {
      const key = `${parsed.metadata.type.toLocaleLowerCase()}\u0000${parsed.metadata.title.toLocaleLowerCase()}`;
      const original = entities.get(key);
      if (original) {
        issues.push({
          code: "duplicate-entity",
          severity: "warning",
          path: filePath,
          message: `Duplicates ${path.relative(workspaceDir, original)} for type and title.`,
        });
      } else {
        entities.set(key, filePath);
      }
    }
  }

  for (const [sourcePath, content] of contentByPath) {
    for (const link of linksIn(content)) {
      if (isExternalLink(link)) continue;
      const [rawPath, rawAnchor] = link.split("#", 2);
      const targetPath = rawPath
        ? path.resolve(path.dirname(sourcePath), decodeURIComponent(rawPath))
        : sourcePath;
      if (!isInside(workspaceDir, targetPath)) {
        issues.push({
          code: "broken-link",
          severity: "error",
          path: sourcePath,
          message: `Link target does not exist: ${link}`,
        });
        continue;
      }

      let targetContent = contentByPath.get(targetPath);
      if (targetContent === undefined) {
        try {
          targetContent = await fs.readFile(targetPath, "utf8");
        } catch {
          issues.push({
            code: "broken-link",
            severity: "error",
            path: sourcePath,
            message: `Link target does not exist: ${link}`,
          });
          continue;
        }
      }
      if (rawAnchor && !headingIds(targetContent).has(rawAnchor)) {
        issues.push({
          code: "broken-anchor",
          severity: "error",
          path: sourcePath,
          message: `Link anchor does not exist: ${link}`,
        });
      }
    }
  }

  return { filesScanned: files.length, issues };
}
