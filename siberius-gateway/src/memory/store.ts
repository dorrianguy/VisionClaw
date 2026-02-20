/**
 * Visual Memory Store — Foundation Layer
 *
 * Every camera snap from vision agents gets indexed here.
 * Uses SQLite for structured metadata + a simple cosine similarity
 * search over embeddings for semantic "what did I see?" queries.
 *
 * Storage: Local SQLite file at data/memory.db
 * Images: Stored as JPEG files in data/captures/
 *
 * This is the base layer that ALL vision agents feed into:
 *   camera_snap → analyze → extract metadata → index in memory store
 *   user query → generate query embedding → vector search → return matches
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { createLogger } from '../logger';

const logger = createLogger('memory-store');

// ─── Types ───

export interface MemoryEntry {
  id: string;
  timestamp: number;
  /** ISO 8601 date string */
  datetime: string;
  /** GPS coordinates if available */
  latitude: number | null;
  longitude: number | null;
  /** Location description (e.g., "Office", "Coffee shop") */
  location: string | null;
  /** Scene classification (indoor/outdoor, room type) */
  sceneType: string | null;
  /** Natural language summary of what was captured */
  summary: string;
  /** OCR-extracted text from the image */
  extractedText: string | null;
  /** Detected objects as JSON array */
  detectedObjects: string[];
  /** Tags for categorization */
  tags: string[];
  /** Which agent triggered the capture */
  sourceAgent: string;
  /** Path to the saved JPEG image */
  imagePath: string | null;
  /** Embedding vector for semantic search (JSON array of floats) */
  embedding: number[] | null;
}

export interface MemoryQueryResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemoryStats {
  totalEntries: number;
  oldestEntry: number | null;
  newestEntry: number | null;
  totalSizeMB: number;
  entriesByAgent: Record<string, number>;
}

// ─── Store Implementation ───

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CAPTURES_DIR = path.join(DATA_DIR, 'captures');
const DB_PATH = path.join(DATA_DIR, 'memory.db');

let db: Database.Database | null = null;

/**
 * Initialize the memory store. Creates the data directory and SQLite
 * database if they don't exist. Safe to call multiple times.
 */
export function initMemoryStore(): void {
  if (db) return;

  // Ensure directories exist
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CAPTURES_DIR, { recursive: true });

  db = new Database(DB_PATH);

  // Enable WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      datetime TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      location TEXT,
      scene_type TEXT,
      summary TEXT NOT NULL,
      extracted_text TEXT,
      detected_objects TEXT, -- JSON array
      tags TEXT,             -- JSON array
      source_agent TEXT NOT NULL,
      image_path TEXT,
      embedding TEXT          -- JSON array of floats
    );

    CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(source_agent);
    CREATE INDEX IF NOT EXISTS idx_memories_location ON memories(location);
    CREATE INDEX IF NOT EXISTS idx_memories_scene ON memories(scene_type);
  `);

  // Full-text search index for text queries
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id,
      summary,
      extracted_text,
      tags,
      content='memories',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(id, summary, extracted_text, tags)
      VALUES (new.id, new.summary, new.extracted_text, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, id, summary, extracted_text, tags)
      VALUES ('delete', old.id, old.summary, old.extracted_text, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, id, summary, extracted_text, tags)
      VALUES ('delete', old.id, old.summary, old.extracted_text, old.tags);
      INSERT INTO memories_fts(id, summary, extracted_text, tags)
      VALUES (new.id, new.summary, new.extracted_text, new.tags);
    END;
  `);

  logger.info({ dbPath: DB_PATH }, 'Memory store initialized');
}

/**
 * Index a new memory entry from a vision agent's camera snap.
 * This is the core write path — called automatically for every
 * vision agent execution when requiresImage is true.
 */
export function indexMemory(entry: Omit<MemoryEntry, 'id' | 'datetime'>): MemoryEntry {
  ensureDb();

  const id = crypto.randomUUID();
  const datetime = new Date(entry.timestamp).toISOString();

  const stmt = db!.prepare(`
    INSERT INTO memories (id, timestamp, datetime, latitude, longitude, location,
      scene_type, summary, extracted_text, detected_objects, tags, source_agent,
      image_path, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    entry.timestamp,
    datetime,
    entry.latitude,
    entry.longitude,
    entry.location,
    entry.sceneType,
    entry.summary,
    entry.extractedText,
    JSON.stringify(entry.detectedObjects),
    JSON.stringify(entry.tags),
    entry.sourceAgent,
    entry.imagePath,
    entry.embedding ? JSON.stringify(entry.embedding) : null,
  );

  logger.info({ id, agent: entry.sourceAgent, summary: entry.summary.slice(0, 60) }, 'Memory indexed');

  return { ...entry, id, datetime };
}

/**
 * Save a JPEG image buffer to the captures directory.
 * Returns the relative path from the data directory.
 */
export function saveCapture(imageBuffer: Buffer, agent: string): string {
  ensureDb();

  const timestamp = Date.now();
  const filename = `${agent}_${timestamp}_${crypto.randomUUID().slice(0, 8)}.jpg`;
  const filepath = path.join(CAPTURES_DIR, filename);

  fs.writeFileSync(filepath, imageBuffer);

  logger.info({ filename, sizeKB: Math.round(imageBuffer.length / 1024) }, 'Capture saved');
  return filepath;
}

/**
 * Query memories by natural language text using full-text search.
 * Falls back to LIKE-based search if FTS yields no results.
 */
export function queryByText(query: string, limit = 10): MemoryQueryResult[] {
  ensureDb();

  // Try FTS first
  const ftsStmt = db!.prepare(`
    SELECT m.*, rank
    FROM memories_fts fts
    JOIN memories m ON fts.id = m.id
    WHERE memories_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  let rows = ftsStmt.all(query, limit) as Array<Record<string, unknown>>;

  // Fallback to LIKE search
  if (rows.length === 0) {
    const likeStmt = db!.prepare(`
      SELECT *, 0 as rank FROM memories
      WHERE summary LIKE ? OR extracted_text LIKE ? OR tags LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const pattern = `%${query}%`;
    rows = likeStmt.all(pattern, pattern, pattern, limit) as Array<Record<string, unknown>>;
  }

  return rows.map(row => ({
    entry: rowToEntry(row),
    score: typeof row.rank === 'number' ? 1 / (1 + Math.abs(row.rank)) : 0.5,
  }));
}

/**
 * Query memories by time range.
 */
export function queryByTimeRange(
  startTime: number,
  endTime: number = Date.now(),
  limit = 50,
): MemoryEntry[] {
  ensureDb();

  const stmt = db!.prepare(`
    SELECT * FROM memories
    WHERE timestamp BETWEEN ? AND ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(startTime, endTime, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

/**
 * Query memories by agent type.
 */
export function queryByAgent(agent: string, limit = 50): MemoryEntry[] {
  ensureDb();

  const stmt = db!.prepare(`
    SELECT * FROM memories
    WHERE source_agent = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(agent, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

/**
 * Query memories by location proximity (simple bounding box).
 */
export function queryByLocation(
  lat: number,
  lon: number,
  radiusKm = 1,
  limit = 20,
): MemoryEntry[] {
  ensureDb();

  // Approximate degrees per km at mid-latitudes
  const latDelta = radiusKm / 111.0;
  const lonDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));

  const stmt = db!.prepare(`
    SELECT * FROM memories
    WHERE latitude BETWEEN ? AND ?
      AND longitude BETWEEN ? AND ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(
    lat - latDelta, lat + latDelta,
    lon - lonDelta, lon + lonDelta,
    limit,
  ) as Array<Record<string, unknown>>;

  return rows.map(rowToEntry);
}

/**
 * Semantic search using cosine similarity on embeddings.
 * This is the "what did I see that looked like X?" query path.
 *
 * NOTE: For production, replace with sqlite-vec extension or
 * a proper vector DB. This brute-force approach works for
 * <50K entries, which covers months of normal use.
 */
export function queryByEmbedding(
  queryEmbedding: number[],
  limit = 10,
  minScore = 0.3,
): MemoryQueryResult[] {
  ensureDb();

  // Fetch all entries with embeddings (for small datasets, brute force is fine)
  const stmt = db!.prepare(`
    SELECT * FROM memories WHERE embedding IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT 10000
  `);

  const rows = stmt.all() as Array<Record<string, unknown>>;
  const scored: MemoryQueryResult[] = [];

  for (const row of rows) {
    const embedding = JSON.parse(row.embedding as string) as number[];
    const score = cosineSimilarity(queryEmbedding, embedding);

    if (score >= minScore) {
      scored.push({ entry: rowToEntry(row), score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Delete memories by time range or specific IDs.
 */
export function deleteMemories(
  opts: { ids?: string[]; beforeTimestamp?: number; olderThanDays?: number },
): number {
  ensureDb();

  if (opts.ids && opts.ids.length > 0) {
    const placeholders = opts.ids.map(() => '?').join(',');
    const stmt = db!.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`);
    const result = stmt.run(...opts.ids);
    logger.info({ count: result.changes, ids: opts.ids.length }, 'Memories deleted by ID');
    return result.changes;
  }

  if (opts.beforeTimestamp) {
    const stmt = db!.prepare('DELETE FROM memories WHERE timestamp < ?');
    const result = stmt.run(opts.beforeTimestamp);
    logger.info({ count: result.changes, before: opts.beforeTimestamp }, 'Memories deleted by timestamp');
    return result.changes;
  }

  if (opts.olderThanDays) {
    const cutoff = Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000;
    const stmt = db!.prepare('DELETE FROM memories WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    logger.info({ count: result.changes, olderThanDays: opts.olderThanDays }, 'Memories deleted by age');
    return result.changes;
  }

  return 0;
}

/**
 * Get stats about the memory store for the health endpoint.
 */
export function getMemoryStats(): MemoryStats {
  ensureDb();

  const countRow = db!.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
  const oldestRow = db!.prepare('SELECT MIN(timestamp) as ts FROM memories').get() as { ts: number | null };
  const newestRow = db!.prepare('SELECT MAX(timestamp) as ts FROM memories').get() as { ts: number | null };

  // Size of DB file + captures
  let totalSizeBytes = 0;
  try {
    const dbStat = fs.statSync(DB_PATH);
    totalSizeBytes += dbStat.size;

    const captureFiles = fs.readdirSync(CAPTURES_DIR);
    for (const file of captureFiles) {
      const fileStat = fs.statSync(path.join(CAPTURES_DIR, file));
      totalSizeBytes += fileStat.size;
    }
  } catch {
    // Directory may not exist yet
  }

  // Count by agent
  const agentRows = db!.prepare(
    'SELECT source_agent, COUNT(*) as count FROM memories GROUP BY source_agent',
  ).all() as Array<{ source_agent: string; count: number }>;

  const entriesByAgent: Record<string, number> = {};
  for (const row of agentRows) {
    entriesByAgent[row.source_agent] = row.count;
  }

  return {
    totalEntries: countRow.count,
    oldestEntry: oldestRow.ts,
    newestEntry: newestRow.ts,
    totalSizeMB: Math.round(totalSizeBytes / (1024 * 1024) * 100) / 100,
    entriesByAgent,
  };
}

/**
 * Close the database connection. Call on shutdown.
 */
export function closeMemoryStore(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Memory store closed');
  }
}

// ─── Helpers ───

function ensureDb(): void {
  if (!db) {
    initMemoryStore();
  }
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    timestamp: row.timestamp as number,
    datetime: row.datetime as string,
    latitude: row.latitude as number | null,
    longitude: row.longitude as number | null,
    location: row.location as string | null,
    sceneType: (row.scene_type as string | null),
    summary: row.summary as string,
    extractedText: (row.extracted_text as string | null),
    detectedObjects: row.detected_objects ? JSON.parse(row.detected_objects as string) : [],
    tags: row.tags ? JSON.parse(row.tags as string) : [],
    sourceAgent: row.source_agent as string,
    imagePath: (row.image_path as string | null),
    embedding: row.embedding ? JSON.parse(row.embedding as string) : null,
  };
}

/**
 * Cosine similarity between two vectors.
 * Returns value between -1 and 1 (1 = identical).
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
