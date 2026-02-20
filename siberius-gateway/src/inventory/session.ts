/**
 * Inventory Vision — Session Manager
 *
 * Manages the lifecycle of an inventory count session:
 *   START → walk aisles → auto-snap → identify products → count → END → export
 *
 * Each session tracks:
 *   - Store info, timestamps, aisle progress
 *   - Running item list with quantities, UPCs, locations, confidence scores
 *   - Photo references for every shelf snap
 *   - Flagged items (low stock, misplaced, unreadable, expired)
 *
 * Stores session data in SQLite alongside the Visual Memory Store.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { createLogger } from '../logger';

const logger = createLogger('inventory-session');

// ─── Types ───

export interface InventorySession {
  id: string;
  storeName: string;
  startedAt: number;
  completedAt: number | null;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  currentAisle: string | null;
  aislesCovered: string[];
  totalItems: number;
  totalSkus: number;
  imagesCaptured: number;
  flaggedCount: number;
  accuracyEstimate: number;
  depthFactor: number;
  notes: string[];
}

export interface InventoryItem {
  id: string;
  sessionId: string;
  upc: string | null;
  name: string;
  category: string | null;
  quantity: number;
  confidence: number;
  aisle: string;
  shelf: string | null;
  position: string | null;
  price: number | null;
  photoRef: string | null;
  method: 'barcode' | 'shelf_label' | 'visual' | 'voice';
  flags: string[];
  timestamp: number;
}

export interface InventoryFlag {
  itemId: string;
  type: 'low_stock' | 'misplaced' | 'expired' | 'damaged' | 'unreadable' | 'mismatch' | 'manual_verify';
  description: string;
  timestamp: number;
}

export interface SessionSummary {
  session: InventorySession;
  items: InventoryItem[];
  flags: InventoryFlag[];
  categoryBreakdown: Record<string, { skus: number; totalQty: number; totalValue: number }>;
  methodBreakdown: Record<string, number>;
  duration: string;
}

// ─── Database ───

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'inventory.db');

let db: Database.Database | null = null;

export function initInventoryDb(): void {
  if (db) return;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_sessions (
      id TEXT PRIMARY KEY,
      store_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      current_aisle TEXT,
      aisles_covered TEXT, -- JSON array
      total_items INTEGER DEFAULT 0,
      total_skus INTEGER DEFAULT 0,
      images_captured INTEGER DEFAULT 0,
      flagged_count INTEGER DEFAULT 0,
      accuracy_estimate REAL DEFAULT 0,
      depth_factor REAL DEFAULT 2.0,
      notes TEXT -- JSON array
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      upc TEXT,
      name TEXT NOT NULL,
      category TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      confidence REAL DEFAULT 0.5,
      aisle TEXT NOT NULL,
      shelf TEXT,
      position TEXT,
      price REAL,
      photo_ref TEXT,
      method TEXT NOT NULL DEFAULT 'visual',
      flags TEXT, -- JSON array
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES inventory_sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_items_session ON inventory_items(session_id);
    CREATE INDEX IF NOT EXISTS idx_items_upc ON inventory_items(upc);
    CREATE INDEX IF NOT EXISTS idx_items_aisle ON inventory_items(aisle);

    CREATE TABLE IF NOT EXISTS inventory_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (item_id) REFERENCES inventory_items(id),
      FOREIGN KEY (session_id) REFERENCES inventory_sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_flags_session ON inventory_flags(session_id);
  `);

  logger.info({ dbPath: DB_PATH }, 'Inventory database initialized');
}

// ─── Session Lifecycle ───

/**
 * Start a new inventory session.
 * Returns the session ID to track all subsequent items.
 */
export function startSession(storeName: string, depthFactor = 2.0): InventorySession {
  ensureDb();

  // Check for existing active session
  const existing = db!.prepare(
    "SELECT id FROM inventory_sessions WHERE status = 'active'",
  ).get() as { id: string } | undefined;

  if (existing) {
    logger.warn({ existingId: existing.id }, 'Active session exists — pausing it first');
    pauseSession(existing.id);
  }

  const session: InventorySession = {
    id: `inv-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`,
    storeName,
    startedAt: Date.now(),
    completedAt: null,
    status: 'active',
    currentAisle: null,
    aislesCovered: [],
    totalItems: 0,
    totalSkus: 0,
    imagesCaptured: 0,
    flaggedCount: 0,
    accuracyEstimate: 0,
    depthFactor,
    notes: [],
  };

  db!.prepare(`
    INSERT INTO inventory_sessions (id, store_name, started_at, status, aisles_covered, depth_factor, notes)
    VALUES (?, ?, ?, 'active', '[]', ?, '[]')
  `).run(session.id, session.storeName, session.startedAt, session.depthFactor);

  logger.info({ sessionId: session.id, store: storeName }, 'Inventory session started');
  return session;
}

/**
 * End the active session and generate summary.
 */
export function endSession(sessionId: string): SessionSummary {
  ensureDb();

  db!.prepare(`
    UPDATE inventory_sessions
    SET status = 'completed', completed_at = ?
    WHERE id = ?
  `).run(Date.now(), sessionId);

  // Recalculate totals
  recalculateSessionTotals(sessionId);

  return getSessionSummary(sessionId);
}

/**
 * Pause the session (user stepped away, break, etc.)
 */
export function pauseSession(sessionId: string): void {
  ensureDb();
  db!.prepare("UPDATE inventory_sessions SET status = 'paused' WHERE id = ?").run(sessionId);
  logger.info({ sessionId }, 'Session paused');
}

/**
 * Resume a paused session.
 */
export function resumeSession(sessionId: string): InventorySession | null {
  ensureDb();
  db!.prepare("UPDATE inventory_sessions SET status = 'active' WHERE id = ? AND status = 'paused'").run(sessionId);
  return getSession(sessionId);
}

/**
 * Get the currently active session, if any.
 */
export function getActiveSession(): InventorySession | null {
  ensureDb();
  const row = db!.prepare("SELECT * FROM inventory_sessions WHERE status = 'active' LIMIT 1").get();
  return row ? rowToSession(row as Record<string, unknown>) : null;
}

/**
 * Get a specific session by ID.
 */
export function getSession(sessionId: string): InventorySession | null {
  ensureDb();
  const row = db!.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId);
  return row ? rowToSession(row as Record<string, unknown>) : null;
}

// ─── Item Management ───

/**
 * Add a scanned item to the current session.
 * If the same UPC already exists in this session + aisle, update quantity.
 */
export function addItem(sessionId: string, item: Omit<InventoryItem, 'id' | 'sessionId' | 'timestamp'>): InventoryItem {
  ensureDb();

  // Check for existing item with same UPC in same aisle
  if (item.upc) {
    const existing = db!.prepare(
      'SELECT id, quantity FROM inventory_items WHERE session_id = ? AND upc = ? AND aisle = ?',
    ).get(sessionId, item.upc, item.aisle) as { id: string; quantity: number } | undefined;

    if (existing) {
      // Update quantity instead of adding duplicate
      const newQty = existing.quantity + item.quantity;
      db!.prepare('UPDATE inventory_items SET quantity = ? WHERE id = ?').run(newQty, existing.id);
      logger.info({ upc: item.upc, oldQty: existing.quantity, newQty }, 'Updated existing item quantity');

      recalculateSessionTotals(sessionId);
      return { ...item, id: existing.id, sessionId, timestamp: Date.now() };
    }
  }

  const entry: InventoryItem = {
    ...item,
    id: crypto.randomUUID(),
    sessionId,
    timestamp: Date.now(),
  };

  db!.prepare(`
    INSERT INTO inventory_items (id, session_id, upc, name, category, quantity, confidence,
      aisle, shelf, position, price, photo_ref, method, flags, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id, sessionId, entry.upc, entry.name, entry.category, entry.quantity,
    entry.confidence, entry.aisle, entry.shelf, entry.position, entry.price,
    entry.photoRef, entry.method, JSON.stringify(entry.flags), entry.timestamp,
  );

  // Add any flags
  for (const flag of item.flags) {
    addFlag(sessionId, entry.id, flag as InventoryFlag['type'], `Auto-flagged: ${flag}`);
  }

  recalculateSessionTotals(sessionId);

  logger.info({
    itemId: entry.id,
    name: entry.name,
    upc: entry.upc,
    qty: entry.quantity,
    method: entry.method,
  }, 'Item added');

  return entry;
}

/**
 * Set the current aisle being scanned.
 */
export function setCurrentAisle(sessionId: string, aisle: string): void {
  ensureDb();

  const session = getSession(sessionId);
  if (!session) return;

  const aisles = session.aislesCovered;
  if (!aisles.includes(aisle)) {
    aisles.push(aisle);
  }

  db!.prepare(`
    UPDATE inventory_sessions
    SET current_aisle = ?, aisles_covered = ?
    WHERE id = ?
  `).run(aisle, JSON.stringify(aisles), sessionId);

  logger.info({ sessionId, aisle }, 'Aisle set');
}

/**
 * Record that an image was captured.
 */
export function recordImageCapture(sessionId: string): void {
  ensureDb();
  db!.prepare('UPDATE inventory_sessions SET images_captured = images_captured + 1 WHERE id = ?').run(sessionId);
}

/**
 * Add a voice note to the session.
 */
export function addNote(sessionId: string, note: string): void {
  ensureDb();
  const session = getSession(sessionId);
  if (!session) return;

  const notes = session.notes;
  notes.push(`[${new Date().toISOString()}] ${note}`);

  db!.prepare('UPDATE inventory_sessions SET notes = ? WHERE id = ?').run(JSON.stringify(notes), sessionId);
}

/**
 * Override an item's quantity (voice command: "count is 24").
 */
export function overrideQuantity(sessionId: string, itemId: string, quantity: number): void {
  ensureDb();
  db!.prepare('UPDATE inventory_items SET quantity = ?, method = ?, confidence = 1.0 WHERE id = ? AND session_id = ?')
    .run(quantity, 'voice', itemId, sessionId);
  recalculateSessionTotals(sessionId);
}

/**
 * Set the shelf depth factor for current session.
 */
export function setDepthFactor(sessionId: string, factor: number): void {
  ensureDb();
  db!.prepare('UPDATE inventory_sessions SET depth_factor = ? WHERE id = ?').run(factor, sessionId);
}

// ─── Flags ───

function addFlag(sessionId: string, itemId: string, type: InventoryFlag['type'], description: string): void {
  db!.prepare(`
    INSERT INTO inventory_flags (item_id, session_id, type, description, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(itemId, sessionId, type, description, Date.now());

  db!.prepare('UPDATE inventory_sessions SET flagged_count = flagged_count + 1 WHERE id = ?').run(sessionId);
}

// ─── Queries ───

/**
 * Get all items for a session.
 */
export function getSessionItems(sessionId: string): InventoryItem[] {
  ensureDb();
  const rows = db!.prepare('SELECT * FROM inventory_items WHERE session_id = ? ORDER BY timestamp').all(sessionId);
  return (rows as Array<Record<string, unknown>>).map(rowToItem);
}

/**
 * Get all flags for a session.
 */
export function getSessionFlags(sessionId: string): InventoryFlag[] {
  ensureDb();
  const rows = db!.prepare('SELECT * FROM inventory_flags WHERE session_id = ? ORDER BY timestamp').all(sessionId);
  return (rows as Array<Record<string, unknown>>).map(row => ({
    itemId: row.item_id as string,
    type: row.type as InventoryFlag['type'],
    description: row.description as string,
    timestamp: row.timestamp as number,
  }));
}

/**
 * Get a full session summary with items, flags, and breakdowns.
 */
export function getSessionSummary(sessionId: string): SessionSummary {
  ensureDb();

  const session = getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const items = getSessionItems(sessionId);
  const flags = getSessionFlags(sessionId);

  // Category breakdown
  const categoryBreakdown: Record<string, { skus: number; totalQty: number; totalValue: number }> = {};
  for (const item of items) {
    const cat = item.category || 'Uncategorized';
    if (!categoryBreakdown[cat]) {
      categoryBreakdown[cat] = { skus: 0, totalQty: 0, totalValue: 0 };
    }
    categoryBreakdown[cat].skus++;
    categoryBreakdown[cat].totalQty += item.quantity;
    categoryBreakdown[cat].totalValue += (item.price || 0) * item.quantity;
  }

  // Method breakdown
  const methodBreakdown: Record<string, number> = {};
  for (const item of items) {
    methodBreakdown[item.method] = (methodBreakdown[item.method] || 0) + 1;
  }

  // Duration string
  const endTime = session.completedAt || Date.now();
  const durationMs = endTime - session.startedAt;
  const hours = Math.floor(durationMs / 3600000);
  const minutes = Math.floor((durationMs % 3600000) / 60000);
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return { session, items, flags, categoryBreakdown, methodBreakdown, duration };
}

/**
 * Get progress stats for TTS feedback during scanning.
 */
export function getProgressStats(sessionId: string): string {
  ensureDb();

  const session = getSession(sessionId);
  if (!session) return 'No active session.';

  const items = getSessionItems(sessionId);
  const uniqueSkus = new Set(items.map(i => i.upc || i.name)).size;
  const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
  const flagged = session.flaggedCount;
  const aisles = session.aislesCovered.length;
  const current = session.currentAisle || 'not set';

  return `${totalQty} items counted across ${uniqueSkus} SKUs in ${aisles} aisles. Currently in aisle ${current}. ${flagged} items flagged for review.`;
}

/**
 * List recent sessions.
 */
export function listSessions(limit = 10): InventorySession[] {
  ensureDb();
  const rows = db!.prepare('SELECT * FROM inventory_sessions ORDER BY started_at DESC LIMIT ?').all(limit);
  return (rows as Array<Record<string, unknown>>).map(rowToSession);
}

// ─── Helpers ───

function ensureDb(): void {
  if (!db) initInventoryDb();
}

function recalculateSessionTotals(sessionId: string): void {
  const items = db!.prepare('SELECT * FROM inventory_items WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;

  const totalItems = items.reduce((sum, row) => sum + (row.quantity as number), 0);
  const uniqueSkus = new Set(items.map(row => (row.upc as string) || (row.name as string))).size;

  // Weighted average confidence
  let totalConf = 0;
  let totalWeight = 0;
  for (const row of items) {
    const qty = row.quantity as number;
    const conf = row.confidence as number;
    totalConf += conf * qty;
    totalWeight += qty;
  }
  const avgAccuracy = totalWeight > 0 ? Math.round((totalConf / totalWeight) * 100) / 100 : 0;

  db!.prepare(`
    UPDATE inventory_sessions
    SET total_items = ?, total_skus = ?, accuracy_estimate = ?
    WHERE id = ?
  `).run(totalItems, uniqueSkus, avgAccuracy, sessionId);
}

function rowToSession(row: Record<string, unknown>): InventorySession {
  return {
    id: row.id as string,
    storeName: row.store_name as string,
    startedAt: row.started_at as number,
    completedAt: row.completed_at as number | null,
    status: row.status as InventorySession['status'],
    currentAisle: row.current_aisle as string | null,
    aislesCovered: row.aisles_covered ? JSON.parse(row.aisles_covered as string) : [],
    totalItems: row.total_items as number,
    totalSkus: row.total_skus as number,
    imagesCaptured: row.images_captured as number,
    flaggedCount: row.flagged_count as number,
    accuracyEstimate: row.accuracy_estimate as number,
    depthFactor: row.depth_factor as number,
    notes: row.notes ? JSON.parse(row.notes as string) : [],
  };
}

function rowToItem(row: Record<string, unknown>): InventoryItem {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    upc: row.upc as string | null,
    name: row.name as string,
    category: row.category as string | null,
    quantity: row.quantity as number,
    confidence: row.confidence as number,
    aisle: row.aisle as string,
    shelf: row.shelf as string | null,
    position: row.position as string | null,
    price: row.price as number | null,
    photoRef: row.photo_ref as string | null,
    method: row.method as InventoryItem['method'],
    flags: row.flags ? JSON.parse(row.flags as string) : [],
    timestamp: row.timestamp as number,
  };
}

export function closeInventoryDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Inventory database closed');
  }
}
