import { Request, Response } from 'express';
import { getAllowedTools } from '../safety/allowlist';
import { getAgentTypes } from '../agents/classifier';
import { hasActiveSessions, getActiveSessions } from '../agents/executor';
import { getMemoryStats } from '../memory/store';

export const healthRoute = (_req: Request, res: Response): void => {
  res.json({
    status: 'ok',
    ready: true,
    gateway: 'siberius',
    version: '2.0.0',
    agents: getAgentTypes().length,
    tools: getAllowedTools().length,
    memory: getMemoryStats(),
    activeSessions: hasActiveSessions() ? getActiveSessions() : undefined,
    uptime: process.uptime(),
  });
};
