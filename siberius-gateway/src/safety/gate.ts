import { v4 as uuid } from 'uuid';
import { config } from '../config';
import { createLogger } from '../logger';

const logger = createLogger('safety-gate');

export type SafetyCategory = 'messaging' | 'purchases' | 'deletions' | 'payments' | 'safe';

interface PendingConfirmation {
  id: string;
  task: string;
  category: SafetyCategory;
  summary: string;
  createdAt: number;
  resolved: boolean;
  approved: boolean;
}

// In-memory store of pending confirmations (TTL: 5 minutes)
const pendingConfirmations = new Map<string, PendingConfirmation>();

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

// Keywords that trigger safety gates per category
const categoryPatterns: Record<SafetyCategory, RegExp[]> = {
  messaging: [
    /\b(send|text|message|dm|email|reply|forward|whatsapp|telegram|imessage|slack)\b/i,
  ],
  purchases: [
    /\b(buy|purchase|order|checkout|subscribe|pay for|add to cart)\b/i,
  ],
  deletions: [
    /\b(delete|remove|erase|destroy|drop|clear|wipe|unsubscribe|cancel)\b/i,
  ],
  payments: [
    /\b(transfer|send money|venmo|zelle|paypal|wire|payment|invoice)\b/i,
  ],
  safe: [],
};

export function classifyTask(task: string): SafetyCategory {
  for (const [category, patterns] of Object.entries(categoryPatterns)) {
    if (category === 'safe') continue;
    for (const pattern of patterns) {
      if (pattern.test(task)) {
        return category as SafetyCategory;
      }
    }
  }
  return 'safe';
}

export function requiresConfirmation(task: string): boolean {
  const category = classifyTask(task);
  return config.confirmActions.includes(category);
}

export function createConfirmation(task: string, category: SafetyCategory): PendingConfirmation {
  const confirmation: PendingConfirmation = {
    id: uuid(),
    task,
    category,
    summary: buildSummary(task, category),
    createdAt: Date.now(),
    resolved: false,
    approved: false,
  };

  pendingConfirmations.set(confirmation.id, confirmation);
  logger.info({ id: confirmation.id, category }, 'Confirmation required');

  // Auto-expire after TTL
  setTimeout(() => {
    const pending = pendingConfirmations.get(confirmation.id);
    if (pending && !pending.resolved) {
      pending.resolved = true;
      pending.approved = false;
      logger.info({ id: confirmation.id }, 'Confirmation expired');
    }
  }, CONFIRMATION_TTL_MS);

  return confirmation;
}

export function resolveConfirmation(id: string, approved: boolean): PendingConfirmation | null {
  const confirmation = pendingConfirmations.get(id);
  if (!confirmation || confirmation.resolved) return null;

  confirmation.resolved = true;
  confirmation.approved = approved;
  logger.info({ id, approved }, 'Confirmation resolved');
  return confirmation;
}

export function getConfirmation(id: string): PendingConfirmation | null {
  return pendingConfirmations.get(id) || null;
}

function buildSummary(task: string, category: SafetyCategory): string {
  switch (category) {
    case 'messaging':
      return `CONFIRM: About to send a message. Task: "${truncate(task, 100)}"`;
    case 'purchases':
      return `CONFIRM: About to make a purchase. Task: "${truncate(task, 100)}"`;
    case 'deletions':
      return `CONFIRM: About to delete something. Task: "${truncate(task, 100)}"`;
    case 'payments':
      return `CONFIRM: About to make a payment/transfer. Task: "${truncate(task, 100)}"`;
    default:
      return task;
  }
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}
