import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { corsOrigins } from './config/env.js';
import { logger, requestLogger } from './lib/logger.js';
import { AppError, NotFoundError, toHttpError } from './lib/errors.js';

export function createApp(): express.Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json());
  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // 404 handler
  app.use((_req, res) => {
    const { status, body } = toHttpError(new NotFoundError('Route not found'));
    res.status(status).json(body);
  });

  // Centralized error handler
  const errorHandler: express.ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    // Operational errors are expected: log at warn without a stack trace.
    // Non-operational / unknown errors are bugs: log at error with the stack.
    if (err instanceof AppError && err.isOperational) {
      logger.warn({ code: err.code, statusCode: err.statusCode }, err.message);
    } else {
      logger.error({ err }, 'Unhandled error');
    }

    const { status, body } = toHttpError(err);
    res.status(status).json(body);
  };
  app.use(errorHandler);

  return app;
}
