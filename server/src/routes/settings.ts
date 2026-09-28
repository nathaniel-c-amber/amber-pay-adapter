import express from 'express';
import rateLimit from 'express-rate-limit';
import { TooManyRequestsError, toHttpError } from '../utils/errors.js';
import { requireAuth, requirePolicyAnyAction } from '../middleware/auth.middleware.js';
import { createSettingsController } from '../controllers/settings.controller.js';
import { settingsService as defaultSettingsService } from '../services/settings/settings.service.js';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
} from '../services/adaptors/intuitOAuth.service.js';
import { env } from '../config/env.js';
import type { SettingsService } from '../services/settings/settings.service.js';
import type { AdaptorRegistry } from '../services/adaptors/registry.js';
import type { AdaptorTransport } from '../types/adaptor.js';

const SETTINGS_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const SETTINGS_MUTATION_RATE_LIMIT_MAX = 30;
/*
  Verification is metered separately, and far more tightly, because it is the one
  settings call whose cost is paid by a THIRD PARTY: each one makes a real request
  to the accounting provider. Sharing the mutation budget would let a console left
  on a settings screen burn a provider's rate limit with retries.
*/
const SETTINGS_VERIFY_RATE_LIMIT_MAX = 10;
/*
  The OAuth callback is UNAUTHENTICATED, so its budget is set on what a stranger
  could cost us rather than on what an operator needs: it is cheap to call and it
  reaches a third party when it succeeds. Verification's budget suits it better
  than the mutation budget, which is sized for a person filling in a form.
*/
const SETTINGS_CALLBACK_RATE_LIMIT_MAX = 20;

/** The scope that governs this deployment's own configuration. */
const SYSTEM_SCOPE = 'system';

function rateLimitHandler(_req: express.Request, res: express.Response): void {
  const { status, body } = toHttpError(new TooManyRequestsError());
  res.status(status).json(body);
}

export interface SettingsRouteDeps {
  settingsService?: SettingsService;
  adaptorRegistry?: AdaptorRegistry;
  /**
   * Outbound transport for the Intuit connect flow. Injectable so the callback can
   * be tested WITHOUT reaching the provider: a test that calls the real endpoint is
   * a test that fails for reasons unrelated to the code, and worse, one that
   * silently depends on the network.
   */
  httpTransport?: AdaptorTransport;
  newNonce?: () => string;
  buildUrl?: typeof buildAuthorizationUrl;
  exchangeCode?: typeof exchangeAuthorizationCode;
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
    ...(deps.httpTransport ? { httpTransport: deps.httpTransport } : {}),
    ...(deps.newNonce ? { newNonce: deps.newNonce } : {}),
    ...(deps.buildUrl ? { buildUrl: deps.buildUrl } : {}),
    ...(deps.exchangeCode ? { exchangeCode: deps.exchangeCode } : {}),
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
  const callbackLimiter = rateLimit({
    windowMs: SETTINGS_RATE_LIMIT_WINDOW_MS,
    max: SETTINGS_CALLBACK_RATE_LIMIT_MAX,
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

  /*
    THE MATCHING RULE IS ADMIN-ONLY, and this is the only line in the file that
    says so.

    It is its own route rather than a key inside `PUT /settings/adaptor` because
    that route is `write OR admin` — the two gates cannot simply be stacked,
    since two in sequence require BOTH and would lock a genuine administrator
    out of a control they are entitled to. Splitting the route gives the setting
    its own, stricter authorization.

    The distinction is not cosmetic. Every other field here describes the
    CONNECTION; this one decides which customer's ledger a real payment is
    applied to. A wrong rule does not fail loudly — it posts against the wrong
    books, or matches nobody and quietly stops posting. Gating only the console
    would have left the capability exactly where it already was, because the API
    is the boundary; hiding the control is a courtesy, not a control.
  */
  const mayAdministerMatching: express.RequestHandler[] = [
    requireAuth,
    requirePolicyAnyAction(['admin'], settingsResource),
  ];
  router.put(
    '/settings/invoice-matching',
    ...mayAdministerMatching,
    mutationLimiter,
    controller.updateInvoiceMatching,
  );

  // POST /api/v1/settings/adaptor/verify — transient probe; records no lifecycle event.
  router.post('/settings/adaptor/verify', ...mayManage, verifyLimiter, controller.verifyAdaptor);

  // POST /api/v1/settings/complete — stamps the first-run flag. Idempotent.
  router.post('/settings/complete', ...mayManage, mutationLimiter, controller.complete);

  /*
    The Intuit connect flow.

    `beginConnect` reads the STORED client credentials, so it is gated like any
    other settings read. It answers with a 302 because the next hop is a human at
    a provider's login page — a browser cannot follow a URL buried in a JSON body.

    `connectCallback` carries NO auth middleware, and that is correct rather than an
    oversight: Intuit redirects the BROWSER here, so there is no bearer token to
    present by the time it arrives. Its protection is the signed, short-lived,
    purpose-bound `state`, verified before the authorization code is even read.
    Gating it on a session would make it impossible to complete, and gating it on
    nothing but hope is what the state exists to prevent.

    The callback is metered separately and tightly: it is unauthenticated, so the
    mutation budget is not the right ceiling for it.
  */
  router.get('/settings/adaptor/connect', ...mayManage, controller.beginConnect);
  router.get('/settings/adaptor/callback', callbackLimiter, controller.connectCallback);

  return router;
}
