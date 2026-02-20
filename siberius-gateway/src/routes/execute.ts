import { Request, Response } from 'express';
import { executeTask } from '../agents/executor';
import { createLogger } from '../logger';

const logger = createLogger('route:execute');

export const executeRoute = async (req: Request, res: Response): Promise<void> => {
  try {
    // Support both direct format and OpenAI chat-completions format
    let task: string;
    let toolName: string;

    if (req.body.task) {
      // Direct Siberius format: POST /execute { task: "...", toolName: "..." }
      task = req.body.task;
      toolName = req.body.toolName || 'execute';
    } else if (req.body.messages) {
      // OpenAI-compatible format: POST /v1/chat/completions { messages: [...] }
      // Extract task from the last user message (how OpenClaw bridge sends it)
      const messages: Array<{ role: string; content: string }> = req.body.messages;
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      task = lastUserMsg?.content || '';
      toolName = 'execute';
    } else {
      res.status(400).json({ success: false, error: 'Missing task or messages' });
      return;
    }

    if (!task) {
      res.status(400).json({ success: false, error: 'Empty task' });
      return;
    }

    logger.info({ task: task.slice(0, 120), toolName }, 'Executing task');

    const result = await executeTask(task);

    // If request came via /v1/chat/completions, return OpenAI-compatible response
    // so existing VisionClaw code can parse it without modification
    if (req.path === '/v1/chat/completions') {
      res.json({
        id: `siberius-${Date.now()}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: result.result,
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        // Extra Siberius metadata
        siberius: {
          agent: result.agent,
          intent: result.intent,
          requiresImage: result.requiresImage,
          confirmationRequired: result.confirmationRequired,
          confirmationId: result.confirmationId,
        },
      });
      return;
    }

    // Direct Siberius format response
    res.json({
      success: result.success,
      result: result.result,
      agent: result.agent,
      intent: result.intent,
      requiresImage: result.requiresImage,
      confirmationRequired: result.confirmationRequired,
      confirmationId: result.confirmationId,
      confirmationSummary: result.confirmationSummary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err: message }, 'Execute failed');
    res.status(500).json({ success: false, error: message });
  }
};
