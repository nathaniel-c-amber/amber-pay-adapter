import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { UnauthorizedError } from '../utils/errors.js';
import { env } from '../config/env.js';
import { getRepositories, isDatabaseConfigured } from '../repositories/index.js';
import { probeAdaptors } from '../services/adaptors/health.service.js';

/** Timestamp the process started serving, reported as `service.startedAt`. */
const STARTED_AT = new Date().toISOString();

export interface ServiceController {
  /** GET /api/v1/service/status */
  getStatus: RequestHandler;
  /** GET /api/v1/health — public liveness probe for the console's status check. */
  getHealth: RequestHandler;
}

/**
 * Service status — the console's window into the backend it is watching.
 *
 * The Overview monitors the payment->accounting link; this endpoint monitors
 * the monitor. Without it the operator cannot tell "the pipeline is healthy"
 * from "the console cannot see the pipeline", which is the failure mode that
 * makes an operations dashboard actively dangerous: every panel reads green
 * while the data underneath is hours old.
 *
 * It reports only non-sensitive operational facts: process uptime, storage
 * backend, and per-adaptor reachability via each adaptor's own `healthCheck()`.
 * No credentials, no endpoints with embedded secrets, no tenant data.
 */
export function createServiceController(): ServiceController {
  return {
    /*
      Liveness only, and deliberately PUBLIC.

      The console's online/offline indicator answers one question — "can this
      browser reach the backend?" — and it has to answer it before sign-in, right
      after a token expires, and while the API is degraded. Behind `requireAuth`
      it would report "offline" at exactly the moments the operator most needs
      the truth, and would conflate "no session" with "no server".

      It exposes nothing: no version, uptime, storage backend or row counts. All
      of that stays behind `getStatus`, which is authenticated and PBAC-gated. A
      liveness probe needs one bit, and returning more would make an
      unauthenticated endpoint into a reconnaissance surface.
    */
    getHealth: asyncHandler(async (_req, res) => {
      res.status(200).json({ status: 'ok' });
    }),

    getStatus: asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }

      const repositories = getRepositories();
      const [adaptors, connectorCount, failureCount] = await Promise.all([
        probeAdaptors(),
        repositories.connectorStates
          .list(null)
          .then((rows) => rows.length)
          .catch(() => null),
        repositories.failures
          .list(null)
          .then((rows) => rows.length)
          .catch(() => null),
      ]);

      res.status(200).json({
        service: {
          name: 'amber-pay-ledger',
          version: process.env['npm_package_version'] ?? '0.0.0',
          environment: env.NODE_ENV,
          nodeVersion: process.version,
          startedAt: STARTED_AT,
          uptimeSeconds: Math.round(process.uptime()),
          storage: isDatabaseConfigured() ? 'postgres' : 'in-memory',
          /** Size of the event window the flow aggregates are derived from. */
          eventWindowLimit: 500,
          rows: { connectors: connectorCount, failures: failureCount },
          adaptors,
        },
        generatedAt: new Date().toISOString(),
      });
    }),
  };
}
