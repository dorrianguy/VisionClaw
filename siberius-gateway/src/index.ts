import express from 'express';
import { createLogger } from './logger';
import { authMiddleware } from './middleware/auth';
import { executeRoute } from './routes/execute';
import { healthRoute } from './routes/health';
import { confirmRoute } from './routes/confirm';
import { inventoryRouter } from './routes/inventory';
import { config } from './config';
import { initMemoryStore, closeMemoryStore } from './memory/store';
import { initInventoryDb, closeInventoryDb } from './inventory/session';
import { initProductDb, closeProductDb } from './inventory/product-db';

const logger = createLogger('server');
const app = express();

// Initialize databases
initMemoryStore();
initInventoryDb();
initProductDb();

app.use(express.json({ limit: '1mb' }));

// Health check (no auth)
app.get('/health', healthRoute);

// Authenticated routes
app.use('/execute', authMiddleware);
app.use('/confirm', authMiddleware);
app.use('/inventory', authMiddleware);

// Core endpoint: VisionClaw calls this
app.post('/execute', executeRoute);

// Confirmation endpoint: for safety-gated actions
app.post('/confirm', confirmRoute);

// Inventory Vision API (dashboard + direct access)
app.use('/inventory', inventoryRouter);

// OpenAI-compatible endpoint (so VisionClaw's existing HTTP format works too)
app.post('/v1/chat/completions', authMiddleware, executeRoute);

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(`Siberius Gateway v2.0.0 running on port ${config.port}`);
  logger.info(`Bound to 0.0.0.0 (LAN accessible)`);
  logger.info(`Safety gates: ${config.confirmActions.join(', ')}`);
  logger.info('Visual Memory Store + Inventory Vision initialized');
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  closeMemoryStore();
  closeInventoryDb();
  closeProductDb();
  server.close();
  process.exit(0);
});
