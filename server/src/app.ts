import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { corsOrigins } from './config/env.js';
import { logger, requestLogger } from './lib/logger.js';
import { AppError, NotFoundError, toHttpError } from './lib/errors.js';
import { createWebhookRouter } from './routes/webhooks.js';
import { createAuthRouter } from './routes/auth.js';
import { createPaymentRouter } from './routes/payments.js';
import { createReportRouter } from './routes/reports.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { getRepositories } from './repositories/index.js';
import type { AuthRouteDeps } from './routes/auth.js';
import type { Repositories } from './repositories/types.js';
import type { AmberPayGateway } from './gateway/types.js';

export interface CreateAppDeps {
  /** Optional auth service overrides (used by tests to inject seams). */
  auth?: AuthRouteDeps;
  /** Optional repository container override (tests inject in-memory). */
  repositories?: Repositories;
  /** Optional gateway override (tests inject a stub). */
  gateway?: AmberPayGateway;
}

export function createApp(deps: CreateAppDeps = {}): express.Express {
  const app = express();
  const repositories = deps.repositories ?? getRepositories();

  app.use(helmet());
  app.use(cors({ origin: corsOrigins }));
  app.use(requestLogger);

  // The webhook route verifies a signature over the RAW request body, so it
  // MUST be mounted before the global JSON body parser.
  app.use('/api/v1', createWebhookRouter());

  app.use(express.json());

  // Auth + data routes rely on a parsed JSON body, so they are mounted AFTER
  // the JSON body parser.
  app.use('/api/v1', createAuthRouter(deps.auth));
  app.use('/api/v1', createPaymentRouter({ payments: repositories.payments, gateway: deps.gateway }));
  app.use('/api/v1', createReportRouter({ reconciliation: repositories.reconciliation }));
  app.use(
    '/api/v1',
    createDashboardRouter({
      connectorStates: repositories.connectorStates,
      events: repositories.events,
      failures: repositories.failures,
    }),
  );

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
