import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { corsOrigins, env } from './config/env.js';
import { requestLogger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import {
  createAuthRouter,
  createDashboardRouter,
  createFailuresRouter,
  createPaymentRouter,
  createReportRouter,
  createServiceRouter,
  createUsersRouter,
  createWebhookRouter,
} from './routes/index.js';
import { getRepositories } from './repositories/index.js';
import type { AuthRouteDeps, UsersRouteDeps } from './routes/index.js';
import type { Repositories } from './types/repository.js';
import type { AmberPayGateway } from './types/gateway.js';

export interface CreateAppDeps {
  /** Optional auth service overrides (used by tests to inject seams). */
  auth?: AuthRouteDeps;
  /** Optional user-directory service override (tests inject a stub). */
  users?: UsersRouteDeps;
  /** Optional repository container override (tests inject in-memory). */
  repositories?: Repositories;
  /** Optional gateway override (tests inject a stub). */
  gateway?: AmberPayGateway;
}

export function createApp(deps: CreateAppDeps = {}): express.Express {
  const app = express();
  const repositories = deps.repositories ?? getRepositories();

  // Must be set before any middleware that reads `req.ip` (rate limiters,
  // `requestLogger`). Without it the console's per-IP throttles all collapse
  // onto the reverse proxy's address, and express-rate-limit reports
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every throttled request.
  app.set('trust proxy', env.TRUSTED_PROXY_HOPS);

  app.use(helmet());
  app.use(cors({ origin: corsOrigins }));
  app.use(requestLogger);

  // The webhook route verifies a signature over the RAW request body, so it
  // MUST be mounted before the global JSON body parser.
  app.use('/api/v1', createWebhookRouter({ gateway: deps.gateway }));

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
  app.use(
    '/api/v1',
    createFailuresRouter({ failures: repositories.failures }),
  );

  // Administrator-only user directory and permission management.
  app.use('/api/v1', createUsersRouter(deps.users));

  // The console's window into its own backend: process, storage and adaptor
  // reachability, so "pipeline healthy" is distinguishable from "console blind".
  app.use('/api/v1', createServiceRouter());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // 404 handler + centralized error handler (see middleware/errorHandler.ts).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
