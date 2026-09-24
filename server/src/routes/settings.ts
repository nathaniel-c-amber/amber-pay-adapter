import express from 'express';
import rateLimit from 'express-rate-limit';
import { TooManyRequestsError, toHttpError } from '../utils/errors.js';
import { requireAuth, requirePolicyAnyAction } from '../middleware/auth.middleware.js';
import { createSettingsController } from '../controllers/settings.controller.js';
import { settingsService as defaultSettingsService } from '../services/settings/settings.service.js';
import { env } from '../config/env.js';
import type { SettingsService } from '../services/settings/settings.service.js';
import type { AdaptorRegistry } from '../services/adaptors/registry.js';

const SETTINGS_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const SETTINGS_MUTATION_RATE_LIMIT_MAX = 30;
/*
  Verification is metered separately, and far more tightly, because it is the one
  settings call whose cost is paid by a THIRD PARTY: each one makes a real request
  to the accounting provider. Sharing the mutation budget would let a console left
  on a settings screen burn a provider's rate limit with retries.
*/
const SETTINGS_VERIFY_RATE_LIMIT_MAX = 10;

/** The scope that governs this deployment's own configuration. */
const SYSTEM_SCOPE = 'system';

function rateLimitHandler(_req: express.Request, res: express.Response): void {
  const { status, body } = toHttpError(new TooManyRequestsError());
  res.status(status).json(body);
}

export interface SettingsRouteDeps {
  settingsService?: SettingsService;
  adaptorRegistry?: AdaptorRegistry;
}

/**
 * Deployment settings routes.
 *
 * THE RESOURCE IS FIXED, not read from the request: there is one deployment and
 * therefore one organization (`env.ORGANIZATION_ID`), so the gate evaluates the
 * caller's policy against that organization rather than against anything the
 * request claims. A caller whose policy names a different organization is
 * refused — correctly, since they do not administer this one — and there is no
 * parameter to tamper with in order to reach another deployment's settings.
 *
 * READS TAKE `read`; WRITES TAKE `write` OR `admin`. The console draws the page
 * for anyone with `read` and locks the controls, so a read-only system holder
 * must be able to fetch what they are being shown; requiring a write action to
 * READ would render the page empty for the one person who should see it.
 */
export function createSettingsRouter(deps: SettingsRouteDeps = {}): express.Router {
  const controller = createSettingsController({
    settingsService: deps.settingsService ?? defaultSettingsService,
    ...(deps.adaptorRegistry ? { adaptorRegistry: deps.adaptorRegistry } : {}),
  });
  const router = express.Router();

  const settingsResource = (): { scope: string; organizationId: string } => ({
    scope: SYSTEM_SCOPE,
    organizationId: env.ORGANIZATION_ID,
  });

  const mutationLimiter = rateLimit({
    windowMs: SETTINGS_RATE_LIMIT_WINDOW_MS,
    max: SETTINGS_MUTATION_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });
  const verifyLimiter = rateLimit({
    windowMs: SETTINGS_RATE_LIMIT_WINDOW_MS,
    max: SETTINGS_VERIFY_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

  const mayRead: express.RequestHandler[] = [
    requireAuth,
    requirePolicyAnyAction(['read', 'write', 'admin'], settingsResource),
  ];
  const mayManage: express.RequestHandler[] = [
    requireAuth,
    requirePolicyAnyAction(['write', 'admin'], settingsResource),
  ];

  // GET /api/v1/settings — presence and last-four of each credential, never a value.
  router.get('/settings', ...mayRead, controller.get);

  // PUT /api/v1/settings/gateway
  router.put('/settings/gateway', ...mayManage, mutationLimiter, controller.updateGateway);

  // PUT /api/v1/settings/adaptor — the chosen accounting system and its credentials.
  router.put('/settings/adaptor', ...mayManage, mutationLimiter, controller.updateAdaptor);

  // PUT /api/v1/settings/preferences
  router.put('/settings/preferences', ...mayManage, mutationLimiter, controller.updatePreferences);

  // POST /api/v1/settings/adaptor/verify — transient probe; records no lifecycle event.
  router.post('/settings/adaptor/verify', ...mayManage, verifyLimiter, controller.verifyAdaptor);

  // POST /api/v1/settings/complete — stamps the first-run flag. Idempotent.
  router.post('/settings/complete', ...mayManage, mutationLimiter, controller.complete);

  return router;
}
