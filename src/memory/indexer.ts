import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { EmbeddingProvider } from "./embeddings.js";
import type { VectorStore } from "./vector-store.js";

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
      // Don't backtrack to same position or before - must make progress
      if (backtrackIdx < lineIdx) {
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

      // Process each file in the current set
      for (const filePath of filePaths) {
        let content: string;
        let stat: { mtimeMs: number; size: number };
        try {
          content = await fs.readFile(filePath, "utf-8");
          const statResult = await fs.stat(filePath);
          stat = { mtimeMs: statResult.mtimeMs, size: statResult.size };
        } catch {
          // File doesn't exist or can't be read - skip
          continue;
        }

        // Compute hash of the file content
        const hash = crypto.createHash("sha256").update(content).digest("hex");

        // Check if the file has changed since last sync
        const existingHash = store.getFileHash(filePath);
        if (existingHash === hash) {
          continue; // File unchanged, skip
        }

        // Delete old chunks for this file
        store.deleteChunksForFile(filePath);

        // Chunk the text
        const chunks = chunkText(content, { tokens: 400, overlap: 80 });

        if (chunks.length === 0) {
          // Empty file - just update the hash
          store.setFileHash(filePath, hash, Math.floor(stat.mtimeMs), stat.size);
          continue;
        }

        // Embed all chunks
        const chunkTexts = chunks.map((c) => c.text);
        const embeddings = await embedder.embedBatch(chunkTexts);

        // Upsert each chunk to the store
        for (let i = 0; i < chunks.length; i++) {
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
