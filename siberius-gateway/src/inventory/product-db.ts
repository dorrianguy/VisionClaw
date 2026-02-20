/**
 * Inventory Vision — Product Database
 *
 * UPC/barcode lookup using free APIs + local cache.
 * Each successful lookup is cached locally in SQLite so repeated
 * scans don't hit the network.
 *
 * Lookup priority:
 *   1. Local cache (instant)
 *   2. Open Food Facts API (free, food/beverage)
 *   3. UPCitemdb API (free tier, general products)
 *   4. Manual entry via voice override
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../logger';

const logger = createLogger('product-db');

// ─── Types ───

export interface Product {
  upc: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  imageUrl: string | null;
  averagePrice: number | null;
  source: 'cache' | 'openfoodfacts' | 'upcitemdb' | 'manual';
  lastUpdated: number;
}

// ─── Database ───

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'products.db');

let db: Database.Database | null = null;

export function initProductDb(): void {
  if (db) return;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      upc TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      category TEXT,
      description TEXT,
      image_url TEXT,
      average_price REAL,
      source TEXT NOT NULL DEFAULT 'manual',
      last_updated INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
  `);

  logger.info({ dbPath: DB_PATH }, 'Product database initialized');
}

// ─── Lookup ───

/**
 * Look up a product by UPC barcode.
 * Checks local cache first, then external APIs.
 */
export async function lookupUpc(upc: string): Promise<Product | null> {
  ensureDb();

  // 1. Check local cache
  const cached = getCachedProduct(upc);
  if (cached) {
    logger.info({ upc, source: 'cache' }, 'Product found in cache');
    return cached;
  }

  // 2. Try Open Food Facts (free, no API key needed)
  const offResult = await lookupOpenFoodFacts(upc);
  if (offResult) {
    cacheProduct(offResult);
    return offResult;
  }

  // 3. Try UPCitemdb (free tier: 100 lookups/day)
  const upcResult = await lookupUpcItemDb(upc);
  if (upcResult) {
    cacheProduct(upcResult);
    return upcResult;
  }

  logger.info({ upc }, 'Product not found in any database');
  return null;
}

/**
 * Manually register a product (from voice command or dashboard).
 */
export function registerProduct(product: Omit<Product, 'lastUpdated' | 'source'>): Product {
  ensureDb();

  const entry: Product = {
    ...product,
    source: 'manual',
    lastUpdated: Date.now(),
  };

  cacheProduct(entry);
  logger.info({ upc: entry.upc, name: entry.name }, 'Product manually registered');
  return entry;
}

/**
 * Search products by name (for non-barcode identification).
 */
export function searchByName(query: string, limit = 10): Product[] {
  ensureDb();

  const stmt = db!.prepare(`
    SELECT * FROM products
    WHERE name LIKE ? OR brand LIKE ? OR category LIKE ?
    ORDER BY last_updated DESC
    LIMIT ?
  `);

  const pattern = `%${query}%`;
  const rows = stmt.all(pattern, pattern, pattern, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToProduct);
}

/**
 * Get product database stats.
 */
export function getProductStats(): { total: number; bySource: Record<string, number> } {
  ensureDb();

  const total = (db!.prepare('SELECT COUNT(*) as c FROM products').get() as { c: number }).c;

  const sourceRows = db!.prepare(
    'SELECT source, COUNT(*) as c FROM products GROUP BY source',
  ).all() as Array<{ source: string; c: number }>;

  const bySource: Record<string, number> = {};
  for (const row of sourceRows) {
    bySource[row.source] = row.c;
  }

  return { total, bySource };
}

// ─── External API Lookups ───

async function lookupOpenFoodFacts(upc: string): Promise<Product | null> {
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${upc}.json`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SiberiusInventoryVision/1.0' },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      status: number;
      product?: {
        product_name?: string;
        brands?: string;
        categories?: string;
        generic_name?: string;
        image_url?: string;
      };
    };

    if (data.status !== 1 || !data.product?.product_name) return null;

    const p = data.product;
    logger.info({ upc, name: p.product_name, source: 'openfoodfacts' }, 'Product found');

    return {
      upc,
      name: p.product_name || `Unknown (${upc})`,
      brand: p.brands || null,
      category: p.categories?.split(',')[0]?.trim() || null,
      description: p.generic_name || null,
      imageUrl: p.image_url || null,
      averagePrice: null, // OFF doesn't have pricing
      source: 'openfoodfacts',
      lastUpdated: Date.now(),
    };
  } catch (err) {
    logger.debug({ upc, err: String(err) }, 'Open Food Facts lookup failed');
    return null;
  }
}

async function lookupUpcItemDb(upc: string): Promise<Product | null> {
  try {
    const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SiberiusInventoryVision/1.0' },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      code: string;
      total: number;
      items?: Array<{
        title?: string;
        brand?: string;
        category?: string;
        description?: string;
        images?: string[];
        lowest_recorded_price?: number;
        highest_recorded_price?: number;
      }>;
    };

    if (data.code !== 'OK' || !data.items?.length) return null;

    const item = data.items[0];
    const avgPrice = item.lowest_recorded_price && item.highest_recorded_price
      ? (item.lowest_recorded_price + item.highest_recorded_price) / 2
      : null;

    logger.info({ upc, name: item.title, source: 'upcitemdb' }, 'Product found');

    return {
      upc,
      name: item.title || `Unknown (${upc})`,
      brand: item.brand || null,
      category: item.category || null,
      description: item.description || null,
      imageUrl: item.images?.[0] || null,
      averagePrice: avgPrice,
      source: 'upcitemdb',
      lastUpdated: Date.now(),
    };
  } catch (err) {
    logger.debug({ upc, err: String(err) }, 'UPCitemdb lookup failed');
    return null;
  }
}

// ─── Cache ───

function getCachedProduct(upc: string): Product | null {
  const row = db!.prepare('SELECT * FROM products WHERE upc = ?').get(upc);
  if (!row) return null;

  const product = rowToProduct(row as Record<string, unknown>);

  // Cache entries older than 30 days are stale — still return but mark for refresh
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - product.lastUpdated > thirtyDays) {
    product.source = 'cache'; // Signal that this might be outdated
  }

  return product;
}

function cacheProduct(product: Product): void {
  db!.prepare(`
    INSERT OR REPLACE INTO products (upc, name, brand, category, description, image_url, average_price, source, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    product.upc, product.name, product.brand, product.category,
    product.description, product.imageUrl, product.averagePrice,
    product.source, product.lastUpdated,
  );
}

// ─── Helpers ───

function ensureDb(): void {
  if (!db) initProductDb();
}

function rowToProduct(row: Record<string, unknown>): Product {
  return {
    upc: row.upc as string,
    name: row.name as string,
    brand: row.brand as string | null,
    category: row.category as string | null,
    description: row.description as string | null,
    imageUrl: row.image_url as string | null,
    averagePrice: row.average_price as number | null,
    source: row.source as Product['source'],
    lastUpdated: row.last_updated as number,
  };
}

export function closeProductDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Product database closed');
  }
}
