export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  apiKey: process.env.SIBERIUS_API_KEY || 'dev-key',
  confirmActions: (process.env.CONFIRM_ACTIONS || 'messaging,purchases,deletions,payments').split(','),
  defaultAgent: process.env.DEFAULT_AGENT || 'siberius',
  enableSubAgents: process.env.ENABLE_SUB_AGENTS === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
} as const;
