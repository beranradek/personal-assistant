import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createLogger } from "../core/logger.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { VectorStore } from "./vector-store.js";

const log = createLogger("indexer");

// ─── Public interfaces ──────────────────────────────────────────────

export interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
}

export interface Indexer {
  syncFiles(filePaths: string[]): Promise<void>;
  markDirty(): void;
  isDirty(): boolean;
  syncIfDirty(filePaths: string[]): Promise<void>;
  close(): void;
}

// ─── preprocessContent ──────────────────────────────────────────────

/**
 * Convert raw file content into searchable text before chunking.
 *
 * For .jsonl files (daily audit logs): parse each line as JSON, extract the
 * meaningful text from interaction entries (timestamp + role + content), and
 * skip tool_use/tool_result noise. Returns a human-readable multi-line string.
 *
 * For all other files: returns rawContent unchanged.
 */
export function preprocessContent(filePath: string, rawContent: string): string {
  if (!path.extname(filePath).toLowerCase().endsWith(".jsonl")) {
    return rawContent;
  }

  const lines = rawContent.split("\n");
  const textParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Skip malformed lines
      continue;
    }

    // Only process interaction entries — skip tool_call and error entries
    if (entry["type"] !== "interaction") continue;

    const timestamp = typeof entry["timestamp"] === "string" ? entry["timestamp"] : "";
    const userMsg = typeof entry["userMessage"] === "string" ? entry["userMessage"].trim() : "";
    const assistantMsg =
      typeof entry["assistantResponse"] === "string"
        ? entry["assistantResponse"].trim()
        : "";

    if (userMsg) {
      textParts.push(`[${timestamp}] user: ${userMsg}`);
    }
    if (assistantMsg) {
      textParts.push(`[${timestamp}] assistant: ${assistantMsg}`);
    }
  }

  return textParts.join("\n");
}

// ─── chunkText ──────────────────────────────────────────────────────

/**
 * Split text into chunks of approximately `options.tokens` tokens,
 * with `options.overlap` tokens of overlap between consecutive chunks.
 *
 * Token estimation: ~4 characters per token.
 * Lines are never split mid-line.
 * Line numbers are 1-indexed.
 */
export function chunkText(
  text: string,
  options: { tokens: number; overlap: number },
): Chunk[] {
  if (text === "") return [];

  const lines = text.split("\n");
  const maxChars = options.tokens * 4;
  const overlapChars = options.overlap * 4;

  const chunks: Chunk[] = [];
  let lineIdx = 0; // 0-based index into lines array

  while (lineIdx < lines.length) {
    let charCount = 0;
    const chunkStartIdx = lineIdx;

    // Accumulate lines until we reach the character budget
    while (lineIdx < lines.length) {
      const lineLen = lines[lineIdx].length + (lineIdx < lines.length - 1 ? 1 : 0); // +1 for newline
      if (charCount + lineLen > maxChars && lineIdx > chunkStartIdx) {
        // This line would exceed the budget and we have at least one line
        break;
      }
      charCount += lineLen;
      lineIdx++;
    }

    // Build the chunk text from chunkStartIdx to lineIdx-1 (inclusive)
    const chunkLines = lines.slice(chunkStartIdx, lineIdx);
    chunks.push({
      text: chunkLines.join("\n"),
      startLine: chunkStartIdx + 1, // 1-indexed
      endLine: lineIdx, // 1-indexed (lineIdx is exclusive in slice, but +1 offset cancels)
    });

    // If we've consumed all lines, we're done
    if (lineIdx >= lines.length) break;

    // Backtrack for overlap
    if (overlapChars > 0) {
      let backtrackChars = 0;
      let backtrackIdx = lineIdx;
      while (backtrackIdx > chunkStartIdx) {
        const prevLineLen = lines[backtrackIdx - 1].length + 1;
        if (backtrackChars + prevLineLen > overlapChars) break;
        backtrackChars += prevLineLen;
        backtrackIdx--;
      }
      // Don't backtrack to chunkStartIdx or before — must make at least
      // one line of forward progress, otherwise we loop forever when the
      // whole chunk fits inside the overlap window.
      if (backtrackIdx > chunkStartIdx && backtrackIdx < lineIdx) {
        lineIdx = backtrackIdx;
      }
    }
  }

  return chunks;
}

// ─── createIndexer ──────────────────────────────────────────────────

/**
 * Create a content indexer that chunks files and syncs them to a vector store.
 */
export function createIndexer(
  store: VectorStore,
  embedder: EmbeddingProvider,
): Indexer {
  let dirty = false;

  return {
    async syncFiles(filePaths: string[]): Promise<void> {
      const currentPathSet = new Set(filePaths);

      // Find previously tracked files that are no longer in the current set
      const trackedPaths = store.getTrackedFilePaths();
      for (const trackedPath of trackedPaths) {
        if (!currentPathSet.has(trackedPath)) {
          // File was removed from sync list - clean up
          store.deleteChunksForFile(trackedPath);
          store.deleteFileHash(trackedPath);
        }
      }

      log.debug({ fileCount: filePaths.length }, "Syncing memory files");

      // Process each file in the current set
      for (const filePath of filePaths) {
        let content: string;
        let stat: { mtimeMs: number; size: number };
        try {
          content = await fs.readFile(filePath, "utf-8");
          const statResult = await fs.stat(filePath);
          stat = { mtimeMs: statResult.mtimeMs, size: statResult.size };
        } catch (err) {
          log.debug({ filePath, err }, "Skipping unreadable file");
          continue;
        }

        // Compute hash of the file content
        const hash = crypto.createHash("sha256").update(content).digest("hex");

        // Check if the file has changed since last sync
        const existingHash = store.getFileHash(filePath);
        if (existingHash === hash) {
          log.debug({ filePath }, "File unchanged, skipping");
          continue;
        }

        // Delete old chunks for this file
        store.deleteChunksForFile(filePath);

        // Extract searchable text (JSONL audit logs get role+content extraction)
        const searchableText = preprocessContent(filePath, content);

        // Chunk the text
        const chunks = chunkText(searchableText, { tokens: 400, overlap: 80 });

        if (chunks.length === 0) {
          // Empty file - just update the hash
          store.setFileHash(filePath, hash, Math.floor(stat.mtimeMs), stat.size);
          log.debug({ filePath }, "Empty file, hash updated");
          continue;
        }

        // Embed all chunks
        const chunkTexts = chunks.map((c) => c.text);
        const embeddings = await embedder.embedBatch(chunkTexts);

        // Upsert each chunk to the store (skip chunks with empty embeddings)
        for (let i = 0; i < chunks.length; i++) {
          if (!embeddings[i] || embeddings[i].length === 0) {
            log.warn({ filePath, chunkIndex: i }, "Empty embedding, skipping chunk");
            continue;
          }
          const chunkId = `${filePath}:${i}`;
          store.upsertChunk({
            id: chunkId,
            path: filePath,
            text: chunks[i].text,
            embedding: embeddings[i],
            startLine: chunks[i].startLine,
            endLine: chunks[i].endLine,
          });
        }

        // Update the file hash
        store.setFileHash(filePath, hash, Math.floor(stat.mtimeMs), stat.size);
        log.info({ filePath, chunks: chunks.length }, "Indexed file");
      }
    },

    markDirty(): void {
      dirty = true;
    },

    isDirty(): boolean {
      return dirty;
    },

    async syncIfDirty(filePaths: string[]): Promise<void> {
      if (!dirty) return;
      await this.syncFiles(filePaths);
      dirty = false;
    },

    close(): void {
      // No resources to clean up in the indexer itself.
      // The store and embedder are owned by the caller.
    },
  };
}
