import { Request, Response } from 'express';
import { resolveConfirmation, getConfirmation } from '../safety/gate';
import { executeTask } from '../agents/executor';
import { createLogger } from '../logger';

const logger = createLogger('route:confirm');

export const confirmRoute = async (req: Request, res: Response): Promise<void> => {
  const { confirmationId, approved } = req.body;

  if (!confirmationId) {
    res.status(400).json({ success: false, error: 'Missing confirmationId' });
    return;
  }

  const confirmation = getConfirmation(confirmationId);
  if (!confirmation) {
    res.status(404).json({ success: false, error: 'Confirmation not found or expired' });
    return;
  }

  const resolved = resolveConfirmation(confirmationId, !!approved);
  if (!resolved) {
    res.status(409).json({ success: false, error: 'Confirmation already resolved' });
    return;
  }

  if (!approved) {
    logger.info({ id: confirmationId }, 'Action denied by Siberius');
    res.json({
      success: true,
      result: `Action denied: "${confirmation.task}" was not approved.`,
      approved: false,
    });
    return;
  }

  // Action approved - now execute the original task (bypassing safety gate this time)
  logger.info({ id: confirmationId }, 'Action approved, executing');
  // TODO: Execute with gate bypass flag so it doesn't loop
  res.json({
    success: true,
    result: `Action approved and executing: "${confirmation.task}"`,
    approved: true,
  });
};
