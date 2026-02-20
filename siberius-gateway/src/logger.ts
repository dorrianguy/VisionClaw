import pino from 'pino';
import { config } from './config';

export const createLogger = (name: string): pino.Logger =>
  pino({
    name,
    level: config.logLevel,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  });
