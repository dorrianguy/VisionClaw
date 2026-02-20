/**
 * Inventory Vision — Export Module
 *
 * Generates inventory reports in multiple formats:
 *   - CSV (universal, works with Excel/Google Sheets)
 *   - JSON (for API consumers and dashboards)
 *   - TTS summary (for voice feedback through glasses)
 *
 * Future: PDF with photos, QuickBooks/Xero compatible format
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../logger';
import { type SessionSummary, type InventoryItem, type InventoryFlag } from './session';

const logger = createLogger('inventory-export');
const EXPORT_DIR = path.resolve(process.cwd(), 'data', 'exports');

/**
 * Export inventory session to CSV file.
 * Returns the file path.
 */
export function exportToCsv(summary: SessionSummary): string {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const filename = `inventory_${summary.session.id}_${new Date().toISOString().slice(0, 10)}.csv`;
  const filepath = path.join(EXPORT_DIR, filename);

  const headers = [
    'UPC', 'Product Name', 'Brand/Category', 'Quantity', 'Unit Price',
    'Total Value', 'Aisle', 'Shelf', 'Position', 'Confidence',
    'ID Method', 'Flags', 'Photo Ref', 'Timestamp',
  ];

  const rows = summary.items.map(item => [
    item.upc || '',
    escapeCsv(item.name),
    escapeCsv(item.category || ''),
    item.quantity.toString(),
    item.price?.toFixed(2) || '',
    item.price ? (item.price * item.quantity).toFixed(2) : '',
    item.aisle,
    item.shelf || '',
    item.position || '',
    (item.confidence * 100).toFixed(0) + '%',
    item.method,
    item.flags.join('; '),
    item.photoRef || '',
    new Date(item.timestamp).toISOString(),
  ]);

  // Session header rows
  const sessionInfo = [
    `# Inventory Report: ${summary.session.storeName}`,
    `# Session ID: ${summary.session.id}`,
    `# Date: ${new Date(summary.session.startedAt).toLocaleDateString()}`,
    `# Duration: ${summary.duration}`,
    `# Total Items: ${summary.session.totalItems}`,
    `# Total SKUs: ${summary.session.totalSkus}`,
    `# Accuracy Estimate: ${(summary.session.accuracyEstimate * 100).toFixed(0)}%`,
    `# Aisles Covered: ${summary.session.aislesCovered.join(', ')}`,
    `# Flagged Items: ${summary.session.flaggedCount}`,
    '',
  ];

  const csvContent = [
    ...sessionInfo,
    headers.join(','),
    ...rows.map(row => row.join(',')),
  ].join('\n');

  fs.writeFileSync(filepath, csvContent, 'utf-8');
  logger.info({ filepath, items: summary.items.length }, 'CSV export complete');
  return filepath;
}

/**
 * Export inventory session as structured JSON.
 */
export function exportToJson(summary: SessionSummary): string {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const filename = `inventory_${summary.session.id}_${new Date().toISOString().slice(0, 10)}.json`;
  const filepath = path.join(EXPORT_DIR, filename);

  const exportData = {
    metadata: {
      exportedAt: new Date().toISOString(),
      version: '1.0.0',
      format: 'siberius-inventory',
    },
    session: {
      id: summary.session.id,
      store: summary.session.storeName,
      started: new Date(summary.session.startedAt).toISOString(),
      completed: summary.session.completedAt ? new Date(summary.session.completedAt).toISOString() : null,
      duration: summary.duration,
      totalItems: summary.session.totalItems,
      totalSkus: summary.session.totalSkus,
      aislesCovered: summary.session.aislesCovered,
      imagesCaptured: summary.session.imagesCaptured,
      accuracyEstimate: summary.session.accuracyEstimate,
      flaggedItems: summary.session.flaggedCount,
    },
    items: summary.items.map(item => ({
      upc: item.upc,
      name: item.name,
      category: item.category,
      quantity: item.quantity,
      confidence: item.confidence,
      location: {
        aisle: item.aisle,
        shelf: item.shelf,
        position: item.position,
      },
      price: item.price,
      totalValue: item.price ? item.price * item.quantity : null,
      method: item.method,
      flags: item.flags,
      photoRef: item.photoRef,
      scannedAt: new Date(item.timestamp).toISOString(),
    })),
    flags: summary.flags.map(flag => ({
      itemId: flag.itemId,
      type: flag.type,
      description: flag.description,
      timestamp: new Date(flag.timestamp).toISOString(),
    })),
    analytics: {
      categoryBreakdown: summary.categoryBreakdown,
      methodBreakdown: summary.methodBreakdown,
      totalInventoryValue: calculateTotalValue(summary.items),
    },
  };

  fs.writeFileSync(filepath, JSON.stringify(exportData, null, 2), 'utf-8');
  logger.info({ filepath, items: summary.items.length }, 'JSON export complete');
  return filepath;
}

/**
 * Generate a TTS-friendly summary for voice delivery through the glasses.
 * Keeps it concise — 15-30 seconds of speech.
 */
export function generateTtsSummary(summary: SessionSummary): string {
  const { session, items, flags } = summary;
  const totalValue = calculateTotalValue(items);
  const valuePart = totalValue > 0 ? ` Total inventory value: $${totalValue.toFixed(0)}.` : '';

  const topCategories = Object.entries(summary.categoryBreakdown)
    .sort((a, b) => b[1].totalQty - a[1].totalQty)
    .slice(0, 3)
    .map(([cat, data]) => `${cat}: ${data.totalQty} items`)
    .join(', ');

  // Flagged summary
  const flagTypes = flags.reduce((acc, f) => {
    acc[f.type] = (acc[f.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const flagParts: string[] = [];
  if (flagTypes.low_stock) flagParts.push(`${flagTypes.low_stock} low stock`);
  if (flagTypes.misplaced) flagParts.push(`${flagTypes.misplaced} misplaced`);
  if (flagTypes.expired) flagParts.push(`${flagTypes.expired} expired`);
  if (flagTypes.manual_verify) flagParts.push(`${flagTypes.manual_verify} need manual verification`);
  const flagSummary = flagParts.length > 0
    ? ` Flagged items: ${flagParts.join(', ')}.`
    : ' No items flagged.';

  return [
    `Inventory complete for ${session.storeName}.`,
    `${summary.duration} total.`,
    `${session.totalItems} items counted across ${session.totalSkus} unique products`,
    `in ${session.aislesCovered.length} aisles.`,
    valuePart,
    `Accuracy estimate: ${(session.accuracyEstimate * 100).toFixed(0)} percent.`,
    `Top categories: ${topCategories}.`,
    flagSummary,
    `Report exported. You can view details on the dashboard.`,
  ].join(' ');
}

/**
 * Generate aisle-completion TTS feedback.
 * Called after each aisle is finished.
 */
export function generateAisleSummary(
  aisle: string,
  items: InventoryItem[],
  flags: InventoryFlag[],
): string {
  const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
  const flagCount = flags.length;
  const flagNote = flagCount > 0 ? ` ${flagCount} items flagged for review.` : '';

  return `Aisle ${aisle} complete. ${totalQty} items counted, ${items.length} unique products.${flagNote}`;
}

// ─── Helpers ───

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function calculateTotalValue(items: InventoryItem[]): number {
  return items.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);
}
