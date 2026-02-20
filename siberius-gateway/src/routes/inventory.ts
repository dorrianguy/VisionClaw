/**
 * Inventory Vision — REST API Routes
 *
 * These routes power the web dashboard and allow direct API access
 * to inventory sessions, items, and exports.
 *
 * All routes require authentication (Bearer token).
 */

import { Router, Request, Response } from 'express';
import { createLogger } from '../logger';
import {
  startSession, endSession, pauseSession, resumeSession,
  getActiveSession, getSession, getSessionSummary, getProgressStats,
  addItem, setCurrentAisle, recordImageCapture, addNote,
  overrideQuantity, setDepthFactor, listSessions, getSessionItems,
} from '../inventory/session';
import { lookupUpc, registerProduct, searchByName, getProductStats } from '../inventory/product-db';
import { exportToCsv, exportToJson, generateTtsSummary } from '../inventory/export';

/** Extract a string param from Express req.params (handles Express 5 types) */
function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

/** Extract a string query param */
function queryStr(req: Request, key: string): string | undefined {
  const val = req.query[key];
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val[0] as string;
  return undefined;
}

const logger = createLogger('route:inventory');

export const inventoryRouter = Router();

// ─── Session Management ───

/** Start a new inventory session */
inventoryRouter.post('/session/start', (req: Request, res: Response) => {
  try {
    const { storeName, depthFactor } = req.body;
    if (!storeName) {
      res.status(400).json({ error: 'storeName is required' });
      return;
    }
    const session = startSession(storeName, depthFactor);
    logger.info({ sessionId: session.id, store: storeName }, 'Session started via API');
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** End the current session and get summary */
inventoryRouter.post('/session/end', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body;
    const active = sessionId ? getSession(sessionId) : getActiveSession();
    if (!active) {
      res.status(404).json({ error: 'No active session found' });
      return;
    }
    const summary = endSession(active.id);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Pause the current session */
inventoryRouter.post('/session/pause', (_req: Request, res: Response) => {
  try {
    const active = getActiveSession();
    if (!active) {
      res.status(404).json({ error: 'No active session' });
      return;
    }
    pauseSession(active.id);
    res.json({ success: true, sessionId: active.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Resume a paused session */
inventoryRouter.post('/session/resume', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const session = resumeSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found or not paused' });
      return;
    }
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Get active session status */
inventoryRouter.get('/session/active', (_req: Request, res: Response) => {
  const session = getActiveSession();
  res.json({ active: !!session, session });
});

/** Get session summary */
inventoryRouter.get('/session/:id', (req: Request, res: Response) => {
  try {
    const summary = getSessionSummary(param(req, 'id'));
    res.json(summary);
  } catch (err) {
    res.status(404).json({ error: String(err) });
  }
});

/** Get live progress stats (for TTS feedback) */
inventoryRouter.get('/session/:id/progress', (req: Request, res: Response) => {
  const stats = getProgressStats(param(req, 'id'));
  res.json({ progress: stats });
});

/** List recent sessions */
inventoryRouter.get('/sessions', (req: Request, res: Response) => {
  const limit = parseInt(queryStr(req, 'limit') || '10') || 10;
  const sessions = listSessions(limit);
  res.json({ sessions });
});

// ─── Item Management ───

/** Add a scanned item to the active session */
inventoryRouter.post('/item', async (req: Request, res: Response) => {
  try {
    const active = getActiveSession();
    if (!active) {
      res.status(400).json({ error: 'No active inventory session' });
      return;
    }

    const { upc, name, category, quantity, confidence, aisle, shelf, position, price, photoRef, method, flags } = req.body;

    // If UPC provided but no name, try to look it up
    let resolvedName = name;
    let resolvedCategory = category;
    let resolvedPrice = price;

    if (upc && !name) {
      const product = await lookupUpc(upc);
      if (product) {
        resolvedName = product.name;
        resolvedCategory = product.category || category;
        resolvedPrice = product.averagePrice || price;
      } else {
        resolvedName = `Unknown Product (${upc})`;
      }
    }

    if (!resolvedName) {
      res.status(400).json({ error: 'Either name or a valid UPC is required' });
      return;
    }

    const item = addItem(active.id, {
      upc: upc || null,
      name: resolvedName,
      category: resolvedCategory || null,
      quantity: quantity || 1,
      confidence: confidence || 0.5,
      aisle: aisle || active.currentAisle || 'unknown',
      shelf: shelf || null,
      position: position || null,
      price: resolvedPrice || null,
      photoRef: photoRef || null,
      method: method || 'visual',
      flags: flags || [],
    });

    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Get all items for a session */
inventoryRouter.get('/session/:id/items', (req: Request, res: Response) => {
  const items = getSessionItems(param(req, 'id'));
  res.json({ items, count: items.length });
});

/** Set current aisle */
inventoryRouter.post('/aisle', (req: Request, res: Response) => {
  try {
    const active = getActiveSession();
    if (!active) {
      res.status(400).json({ error: 'No active session' });
      return;
    }
    const { aisle } = req.body;
    if (!aisle) {
      res.status(400).json({ error: 'aisle is required' });
      return;
    }
    setCurrentAisle(active.id, aisle);
    res.json({ success: true, aisle });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Record an image capture */
inventoryRouter.post('/capture', (_req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(400).json({ error: 'No active session' });
    return;
  }
  recordImageCapture(active.id);
  res.json({ success: true });
});

/** Add a voice note */
inventoryRouter.post('/note', (req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(400).json({ error: 'No active session' });
    return;
  }
  const { note } = req.body;
  if (!note) {
    res.status(400).json({ error: 'note is required' });
    return;
  }
  addNote(active.id, note);
  res.json({ success: true });
});

/** Override item quantity */
inventoryRouter.post('/item/:id/quantity', (req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(400).json({ error: 'No active session' });
    return;
  }
  const { quantity } = req.body;
  if (typeof quantity !== 'number') {
    res.status(400).json({ error: 'quantity must be a number' });
    return;
  }
  overrideQuantity(active.id, param(req, 'id'), quantity);
  res.json({ success: true });
});

/** Set depth factor */
inventoryRouter.post('/depth', (req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(400).json({ error: 'No active session' });
    return;
  }
  const { factor } = req.body;
  if (typeof factor !== 'number') {
    res.status(400).json({ error: 'factor must be a number' });
    return;
  }
  setDepthFactor(active.id, factor);
  res.json({ success: true, depthFactor: factor });
});

// ─── Product Lookup ───

/** Look up a product by UPC */
inventoryRouter.get('/product/:upc', async (req: Request, res: Response) => {
  const product = await lookupUpc(param(req, 'upc'));
  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  res.json({ product });
});

/** Register a product manually */
inventoryRouter.post('/product', (req: Request, res: Response) => {
  const { upc, name, brand, category, description, averagePrice } = req.body;
  if (!upc || !name) {
    res.status(400).json({ error: 'upc and name are required' });
    return;
  }
  const product = registerProduct({
    upc, name, brand, category, description,
    imageUrl: null, averagePrice: averagePrice || null,
  });
  res.json({ success: true, product });
});

/** Search products by name */
inventoryRouter.get('/products/search', (req: Request, res: Response) => {
  const query = queryStr(req, 'q');
  if (!query) {
    res.status(400).json({ error: 'q query parameter is required' });
    return;
  }
  const results = searchByName(query);
  res.json({ results });
});

/** Get product database stats */
inventoryRouter.get('/products/stats', (_req: Request, res: Response) => {
  res.json(getProductStats());
});

// ─── Export ───

/** Export session to CSV */
inventoryRouter.get('/session/:id/export/csv', (req: Request, res: Response) => {
  try {
    const summary = getSessionSummary(param(req, 'id'));
    const filepath = exportToCsv(summary);
    res.download(filepath);
  } catch (err) {
    res.status(404).json({ error: String(err) });
  }
});

/** Export session to JSON */
inventoryRouter.get('/session/:id/export/json', (req: Request, res: Response) => {
  try {
    const summary = getSessionSummary(param(req, 'id'));
    const filepath = exportToJson(summary);
    res.download(filepath);
  } catch (err) {
    res.status(404).json({ error: String(err) });
  }
});

/** Get TTS summary for voice delivery */
inventoryRouter.get('/session/:id/export/tts', (req: Request, res: Response) => {
  try {
    const summary = getSessionSummary(param(req, 'id'));
    const tts = generateTtsSummary(summary);
    res.json({ tts });
  } catch (err) {
    res.status(404).json({ error: String(err) });
  }
});
