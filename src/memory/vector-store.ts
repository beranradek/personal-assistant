import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// ─── Public interfaces ──────────────────────────────────────────────

export interface ChunkRecord {
  id: string;
  path: string;
  text: string;
  embedding: number[];
  startLine: number;
  endLine: number;
}

export interface VectorSearchResult {
  id: string;
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  distance: number; // cosine distance (lower = more similar)
}

export interface KeywordSearchResult {
  id: string;
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  rank: number; // BM25 rank (lower = more relevant)
}

export interface VectorStore {
  upsertChunk(chunk: ChunkRecord): void;
  searchVector(queryEmbedding: number[], limit: number): VectorSearchResult[];
  searchKeyword(query: string, limit: number): KeywordSearchResult[];
  deleteChunksForFile(filePath: string): void;
  getFileHash(filePath: string): string | null;
  setFileHash(
    filePath: string,
    hash: string,
    mtime: number,
    size: number,
  ): void;
  close(): void;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Convert a number[] embedding to a Buffer of little-endian float32 values,
 * which is the format sqlite-vec expects.
 */
function embeddingToBuffer(embedding: number[]): Buffer {
  const buf = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}

// ─── Factory ────────────────────────────────────────────────────────

/**
 * Create a new VectorStore backed by SQLite with sqlite-vec for vector search
 * and FTS5 for keyword search.
 *
 * @param dbPath  - Path to the SQLite database file, or `:memory:` for in-memory.
 * @param dimensions - Number of dimensions for embedding vectors.
 */
export function createVectorStore(
  dbPath: string,
  dimensions: number,
): VectorStore {
  const db = new Database(dbPath);
  sqliteVec.load(db);

  // Enable WAL mode for better concurrent read/write performance
  db.pragma("journal_mode = WAL");

  // ── Schema creation ─────────────────────────────────────────────

  // Main chunks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id         TEXT PRIMARY KEY,
      path       TEXT NOT NULL,
      text       TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line   INTEGER NOT NULL
    )
  `);

  // sqlite-vec virtual table for vector search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec
    USING vec0(id TEXT PRIMARY KEY, embedding float[${dimensions}])
  `);

  // FTS5 virtual table for keyword search (content-sync with chunks)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
    USING fts5(id, text, content='chunks', content_rowid='rowid')
  `);

  // File hash tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path  TEXT PRIMARY KEY,
      hash  TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size  INTEGER NOT NULL
    )
  `);

  // ── Prepared statements ─────────────────────────────────────────

  const getChunkStmt = db.prepare(
    `SELECT id FROM chunks WHERE id = ?`,
  );

  const insertChunkStmt = db.prepare(`
    INSERT INTO chunks (id, path, text, start_line, end_line)
    VALUES (@id, @path, @text, @startLine, @endLine)
  `);

  const updateChunkStmt = db.prepare(`
    UPDATE chunks
    SET path = @path, text = @text, start_line = @startLine, end_line = @endLine
    WHERE id = @id
  `);

  // sqlite-vec: insert and delete for vec table
  const insertVecStmt = db.prepare(`
    INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)
  `);

  const deleteVecStmt = db.prepare(`
    DELETE FROM chunks_vec WHERE id = ?
  `);

  // FTS5: manual insert/delete (content-sync requires manual management)
  const insertFtsStmt = db.prepare(`
    INSERT INTO chunks_fts (rowid, id, text)
    VALUES ((SELECT rowid FROM chunks WHERE id = @id), @id, @text)
  `);

  const deleteFtsStmt = db.prepare(`
    DELETE FROM chunks_fts WHERE id = ?
  `);

  // Vector search: sqlite-vec MATCH query
  // sqlite-vec requires `k = ?` constraint in WHERE clause for KNN queries
  const searchVecStmt = db.prepare(`
    SELECT v.id, v.distance, c.path, c.text, c.start_line, c.end_line
    FROM chunks_vec v
    JOIN chunks c ON c.id = v.id
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `);

  // Keyword search: FTS5 BM25 query
  const searchFtsStmt = db.prepare(`
    SELECT f.id, f.rank, c.path, c.text, c.start_line, c.end_line
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.id
    WHERE chunks_fts MATCH ?
    ORDER BY f.rank
    LIMIT ?
  `);

  // Chunk deletion by file path
  const getChunkIdsByPathStmt = db.prepare(
    `SELECT id, rowid FROM chunks WHERE path = ?`,
  );

  const deleteChunkByIdStmt = db.prepare(
    `DELETE FROM chunks WHERE id = ?`,
  );

  // File hash statements
  const getFileHashStmt = db.prepare(
    `SELECT hash FROM files WHERE path = ?`,
  );

  const upsertFileHashStmt = db.prepare(`
    INSERT INTO files (path, hash, mtime, size)
    VALUES (@path, @hash, @mtime, @size)
    ON CONFLICT(path) DO UPDATE SET
      hash = excluded.hash,
      mtime = excluded.mtime,
      size = excluded.size
  `);

  // ── Transactional upsert ────────────────────────────────────────

  const upsertChunkTx = db.transaction((chunk: ChunkRecord) => {
    const embeddingBuf = embeddingToBuffer(chunk.embedding);
    const existing = getChunkStmt.get(chunk.id) as { id: string } | undefined;

    if (existing) {
      // Update: remove old FTS and vec entries, then re-insert
      deleteFtsStmt.run(chunk.id);
      deleteVecStmt.run(chunk.id);
      updateChunkStmt.run({
        id: chunk.id,
        path: chunk.path,
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
    } else {
      // Insert new chunk
      insertChunkStmt.run({
        id: chunk.id,
        path: chunk.path,
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
    }

    // Insert into vec and FTS tables
    insertVecStmt.run(chunk.id, embeddingBuf);
    insertFtsStmt.run({ id: chunk.id, text: chunk.text });
  });

  // Transactional delete for file path
  const deleteChunksForFileTx = db.transaction((filePath: string) => {
    const rows = getChunkIdsByPathStmt.all(filePath) as Array<{
      id: string;
      rowid: number;
    }>;

    for (const row of rows) {
      deleteFtsStmt.run(row.id);
      deleteVecStmt.run(row.id);
      deleteChunkByIdStmt.run(row.id);
    }
  });

  // ── Public API ──────────────────────────────────────────────────

  return {
    upsertChunk(chunk: ChunkRecord): void {
      upsertChunkTx(chunk);
    },

    searchVector(
      queryEmbedding: number[],
      limit: number,
    ): VectorSearchResult[] {
      const buf = embeddingToBuffer(queryEmbedding);
      const rows = searchVecStmt.all(buf, limit) as Array<{
        id: string;
        distance: number;
        path: string;
        text: string;
        start_line: number;
        end_line: number;
      }>;

      return rows.map((r) => ({
        id: r.id,
        path: r.path,
        text: r.text,
        startLine: r.start_line,
        endLine: r.end_line,
        distance: r.distance,
      }));
    },

    searchKeyword(query: string, limit: number): KeywordSearchResult[] {
      try {
        const rows = searchFtsStmt.all(query, limit) as Array<{
          id: string;
          rank: number;
          path: string;
          text: string;
          start_line: number;
          end_line: number;
        }>;

        return rows.map((r) => ({
          id: r.id,
          path: r.path,
          text: r.text,
          startLine: r.start_line,
          endLine: r.end_line,
          rank: r.rank,
        }));
      } catch {
        // FTS5 MATCH can throw on empty index or invalid query
        return [];
      }
    },

    deleteChunksForFile(filePath: string): void {
      deleteChunksForFileTx(filePath);
    },

    getFileHash(filePath: string): string | null {
      const row = getFileHashStmt.get(filePath) as
        | { hash: string }
        | undefined;
      return row?.hash ?? null;
    },

    setFileHash(
      filePath: string,
      hash: string,
      mtime: number,
      size: number,
    ): void {
      upsertFileHashStmt.run({ path: filePath, hash, mtime, size });
    },

    close(): void {
      db.close();
    },
  };
}
