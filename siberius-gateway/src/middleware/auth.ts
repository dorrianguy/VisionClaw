import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { createLogger } from '../logger';

const logger = createLogger('auth');

export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Request missing Bearer token');
    res.status(401).json({ success: false, error: 'Missing authorization' });
    return;
  }

  const token = authHeader.slice(7);

  if (token !== config.apiKey) {
    logger.warn('Invalid API key');
    res.status(403).json({ success: false, error: 'Invalid API key' });
    return;
  }

  next();
};
