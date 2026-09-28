import { z } from 'zod';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { UnauthorizedError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { verifyAdaptorConnection } from '../services/settings/verify.service.js';
import { syncConfiguredAdaptor } from '../services/adaptors/activeAdaptor.service.js';
import { adaptorRegistry as defaultAdaptorRegistry } from '../services/adaptors/registry.js';
import { httpTransport } from '../services/adaptors/httpTransport.js';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  newNonce,
  readRealmId,
  redirectUri,
} from '../services/adaptors/intuitOAuth.service.js';
import { issueOAuthState, verifyOAuthState } from '../utils/oauthState.js';
import type { SettingsService } from '../services/settings/settings.service.js';
import type { AdaptorRegistry } from '../services/adaptors/registry.js';
import type { AdaptorCredentials, AdaptorTransport } from '../types/adaptor.js';
import type { AdaptorVerification } from '../services/settings/verify.service.js';

/**
 * Field names, not values, are the contract here.
 *
 * Every mutation schema is STRICT, so a misspelled key is a 400 rather than a
 * silent success. Zod strips unknown keys by default, which would answer "saved"
 * to a request that changed nothing — and a console that says "saved" when it did
 * not is worse than one that errors, because the operator's next move is to
 * leave.
 */
const gatewayBodySchema = z
  .object({
    clientId: z.string().min(1).nullable().optional(),
    webhookSecret: z.string().min(1).nullable().optional(),
  })
  .strict();

const adaptorBodySchema = z
  .object({
    id: z.enum(['quickbooks', 'sage']).nullable().optional(),
    realmId: z.string().min(1).nullable().optional(),
    baseUrl: z.string().min(1).nullable().optional(),
    /**
     * MERGED, not replaced. `null` clears one field, a blank string is treated by
     * the service as "not filled in", and an absent key changes nothing.
     */
    credentials: z.record(z.string().nullable()).nullable().optional(),
  })
  .strict();

/**
 * The customer matching rule, on its own route.
 *
 * `.strict()` for the same reason as every other body here: zod strips unknown
 * keys by default, which would answer "saved" for a rule that did not change —
 * and this rule decides which customer's ledger a payment is applied to, so a
 * silently dropped key is worse here than anywhere else on the page.
 */
const invoiceMatchingBodySchema = z
  .object({
    strategy: z.enum(['displayName', 'customField', 'notes']).nullable().optional(),
    mode: z.enum(['exact', 'contains']).nullable().optional(),
    fieldName: z.string().min(1).nullable().optional(),
    depositAccountId: z.string().min(1).nullable().optional(),
  })
  .strict();

const preferencesBodySchema = z
  .object({
    organizationName: z.string().min(1).nullable().optional(),
    syncInterval: z.string().min(1).nullable().optional(),
    alertTarget: z.string().min(1).nullable().optional(),
  })
  .strict();

const verifyBodySchema = z
  .object({
    id: z.enum(['quickbooks', 'sage']).optional(),
    realmId: z.string().optional(),
    baseUrl: z.string().optional(),
    credentials: z.record(z.string()).optional(),
  })
  .strict();

/** Keep only the string-valued fields of a credential set. */
function stringFields(credentials: AdaptorCredentials): Record<string, string> {
  return Object.fromEntries(
    Object.entries(credentials).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export interface SettingsControllerDeps {
  settingsService: SettingsService;
  /** Test seams: the registry the throwaway instance is built from. */
  adaptorRegistry?: AdaptorRegistry;
  verifyAdaptor?: typeof verifyAdaptorConnection;
  /** Test seams for the Intuit connect flow. */
  httpTransport?: AdaptorTransport;
  newNonce?: () => string;
  buildUrl?: typeof buildAuthorizationUrl;
  exchangeCode?: typeof exchangeAuthorizationCode;
}

export interface SettingsController {
  /** GET /api/v1/settings — presence and last-four only, never a value. */
  get: RequestHandler;
  /** PUT /api/v1/settings/gateway */
  updateGateway: RequestHandler;
  /** PUT /api/v1/settings/adaptor */
  updateAdaptor: RequestHandler;
  /**
   * PUT /api/v1/settings/invoice-matching — ADMIN ONLY.
   *
   * A separate handler, and a separate route, because this setting decides which
   * customer's ledger a real payment lands in. Every other field on this page
   * describes the connection; this one steers the money.
   */
  updateInvoiceMatching: RequestHandler;
  /** PUT /api/v1/settings/preferences */
  updatePreferences: RequestHandler;
  /** POST /api/v1/settings/adaptor/verify — transient, writes nothing it tested. */
  verifyAdaptor: RequestHandler;
  /** POST /api/v1/settings/complete — stamps the first-run flag, idempotent. */
  complete: RequestHandler;
  /**
   * GET /api/v1/settings/adaptor/connect — 302 to Intuit for consent.
   * Requires a session, because it reads the stored client credentials.
   */
  beginConnect: RequestHandler;
  /**
   * GET /api/v1/settings/adaptor/callback — Intuit's redirect target.
   * NO session: the provider redirects the browser, so there is no bearer token
   * to present. The signed `state` is the entire authorisation.
   */
  connectCallback: RequestHandler;
}

/**
 * Deployment configuration.
 *
 * The WRITE-ONLY rule is enforced a layer down, in `SettingsService`: there is no
 * projection in this file, or reachable from it, that returns a stored
 * credential. What the controller must not do is invent one — so every response
 * is the service's own read model, passed through untouched.
 *
 * Authorization is enforced in the route (`system` scope for this deployment's
 * organization), so nothing here re-checks it.
 */
export function createSettingsController(deps: SettingsControllerDeps): SettingsController {
  const verifyAdaptor = deps.verifyAdaptor ?? verifyAdaptorConnection;

  return {
    get: asyncHandler(async (_req, res) => {
      res.status(200).json({ settings: await deps.settingsService.getSettings() });
    }),

    updateGateway: asyncHandler(async (req, res) => {
      const parsed = gatewayBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Invalid gateway settings payload');
      }
      res.status(200).json({ settings: await deps.settingsService.updateGateway(parsed.data) });
    }),

    updateAdaptor: asyncHandler(async (req, res) => {
      const parsed = adaptorBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Invalid adaptor settings payload');
      }
      const settings = await deps.settingsService.updateAdaptor(parsed.data);

      /*
        A SAVED CONFIGURATION MUST TAKE EFFECT NOW, or the operator watches their
        correction change nothing.

        The registry caches ONE instance per adaptor, and that instance holds the
        credentials it connected with and, for QuickBooks, a ROTATED refresh token.
        Without a reset, the console keeps reporting the previous failure until the
        process restarts, and the natural response — enter it again, more carefully
        — cannot help. `syncConfiguredAdaptor` also moves WHICH system this
        deployment uses, which is the other half of "configured at setup".
      */
      const registry = deps.adaptorRegistry ?? defaultAdaptorRegistry;
      const activeId = await syncConfiguredAdaptor(registry, deps.settingsService);
      if (activeId) {
        registry.reset(activeId);
      }

      res.status(200).json({ settings });
    }),

    updateInvoiceMatching: asyncHandler(async (req, res) => {
      // `null` clears the whole rule; anything else is a partial write.
      const parsed = invoiceMatchingBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Invalid invoice matching payload');
      }
      res.status(200).json({
        settings: await deps.settingsService.updateInvoiceMatching(parsed.data),
      });
    }),

    updatePreferences: asyncHandler(async (req, res) => {
      const parsed = preferencesBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Invalid preferences payload');
      }
      res.status(200).json({ settings: await deps.settingsService.updatePreferences(parsed.data) });
    }),

    verifyAdaptor: asyncHandler(async (req, res) => {
      if (!req.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const parsed = verifyBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Invalid verification payload');
      }
      const body = parsed.data;

      const stored = await deps.settingsService.resolveCredentials();
      const adaptorId = body.id ?? stored.adaptor?.id ?? null;
      if (!adaptorId) {
        throw new ValidationError('Choose an accounting system before testing its connection');
      }

      /*
        TWO MODES, and the difference decides whether anything is recorded.
        SUPPLIED credentials test a value that is not saved yet, which is the
        wizard's step 4: the operator is asking "would this work?", so the answer
        must not be written down. STORED credentials test what this deployment is
        actually configured with, which is the console's re-verify, and a pass
        there is a real fact about the row.
      */
      const supplied = body.credentials ?? null;
      const testingStored = supplied === null;
      if (testingStored && stored.adaptor?.id !== adaptorId) {
        /*
          The stored credentials belong to the other system. Testing them against
          this choice would answer a question nobody asked and, worse, would
          probably succeed — suggesting a connection to a system this deployment
          does not use. Refuse instead of testing the wrong thing.
        */
        throw new ValidationError(`No stored credentials for '${adaptorId}' to test`);
      }

      const credentials: AdaptorCredentials = {
        ...(supplied ?? stored.adaptor?.fields ?? {}),
        realmId: body.realmId ?? stored.adaptor?.realmId ?? undefined,
        baseUrl: body.baseUrl ?? stored.adaptor?.baseUrl ?? undefined,
      };

      const verification: AdaptorVerification = await verifyAdaptor(
        adaptorId,
        credentials,
        deps.adaptorRegistry,
      );

      if (verification.ok && testingStored) {
        /*
          A rotation is persisted even though the credentials were "only read":
          QuickBooks invalidates the refresh token as it spends it, so discarding
          the replacement would kill this connection on the next restart — the R5
          defect, arriving one token-lifetime after a screen that said "healthy".
        */
        if (verification.rotated) {
          await deps.settingsService.storeRotatedCredentials(stringFields(verification.rotated));
        }
        await deps.settingsService.markVerified();
      }

      /*
        200 WITH A NEGATIVE VERDICT. A rejected credential is the expected result
        of an operator typing one, so it is an answer, not a transport failure —
        and the wizard needs the classified `reason` in order to say anything
        useful. An error status here would force every caller to unpack a body out
        of an exception to learn the same thing.

        THE VIEW IS BUILT FIELD BY FIELD ON PURPOSE, and `rotated` is absent. That
        value is a live credential: in STORED mode it was just minted from the
        sealed refresh token, so echoing it would put a stored secret into an HTTP
        response — the one thing this whole surface exists to prevent. The caller
        has no use for it either (the server persists it; in SUPPLIED mode the
        caller is the one who sent it). An explicit projection rather than an
        omit-rest idiom, so that a field added to the service type later is NOT
        silently published here.
      */
      res.status(200).json({
        verification: {
          ok: verification.ok,
          adaptorId: verification.adaptorId,
          latencyMs: verification.latencyMs,
          message: verification.message,
          reason: verification.reason,
        },
      });
    }),

    complete: asyncHandler(async (_req, res) => {
      res.status(200).json({ settings: await deps.settingsService.complete() });
    }),

    /**
     * Send the operator to Intuit to log in and consent.
     *
     * A 302 rather than a JSON body: the next hop is a human at a provider's login
     * page, and a browser cannot follow a URL that is buried in a response. The
     * `state` is minted here and is the only thing tying the callback back to this
     * attempt.
     */
    beginConnect: asyncHandler(async (_req, res) => {
      const stored = await deps.settingsService.resolveCredentials();
      const clientId = stored.adaptor?.fields['clientId'];
      const clientSecret = stored.adaptor?.fields['clientSecret'];
      if (!clientId || !clientSecret) {
        throw new ValidationError(
          'Save the QuickBooks client ID and client secret first, then connect.',
        );
      }

      const buildUrl = deps.buildUrl ?? buildAuthorizationUrl;
      const nonce = (deps.newNonce ?? newNonce)();
      const state = issueOAuthState('quickbooks', nonce);

      /*
        A URL, NOT A 302.

        This route is behind `requireAuth`, and that is correct: it reads the stored
        client credentials, and an unauthenticated stranger must not be able to start
        an authorization against this deployment. But a browser NAVIGATION carries
        no `Authorization` header, so a 302 from this endpoint was unreachable —
        the button it backed could only ever produce 401.

        Handing the URL back to the caller instead lets the client authenticate the
        call and then navigate, which is how every other OAuth integration does it.
        The URL contains no secret: `client_id` is public, `redirect_uri` is this
        deployment's own callback, and `state` is a signed nonce that expires in ten
        minutes.
      */
      res.status(200).json({
        authorizationUrl: buildUrl({
          clientId,
          redirectUri: redirectUri(),
          state,
        }),
      });
    }),

    /**
     * Intuit's redirect target.
     *
     * THE ORDER OF OPERATIONS IS THE SECURITY PROPERTY. The state is verified
     * BEFORE the authorization code is even looked at, and before any credential is
     * read. A callback with a forged or missing state must not be able to make this
     * process exchange anything, store anything, or reveal whether a grant exists —
     * so the state check happens first and returns on failure, and the only thing
     * the operator sees either way is the same generic message.
     *
     * On success the browser is redirected to the console with a `connected`
     * marker and NO token material in the URL. A token in a redirect URL lands in
     * browser history, in `Referer` headers on the next navigation, and in any
     * proxy log along the way.
     */
    connectCallback: asyncHandler(async (req, res) => {
      const rawState = typeof req.query['state'] === 'string' ? req.query['state'] : '';
      const rawCode = typeof req.query['code'] === 'string' ? req.query['code'] : '';
      const realmId = readRealmId(req.query['realmId']);

      const deny = (reason: string) =>
        res.redirect(302, `${env.APP_BASE_URL.replace(/\/+$/, '')}/#/onboarding?connect=error&reason=${encodeURIComponent(reason)}`);

      // 1. State FIRST. Nothing else runs until it passes.
      try {
        verifyOAuthState(rawState, 'quickbooks');
      } catch {
        return deny('unverified');
      }

      // 2. The provider may also report a refusal in its own way.
      if (typeof req.query['error'] === 'string') {
        return deny('declined');
      }
      if (!rawCode) {
        return deny('no_code');
      }

      const stored = await deps.settingsService.resolveCredentials();
      const clientId = stored.adaptor?.fields['clientId'];
      const clientSecret = stored.adaptor?.fields['clientSecret'];
      if (!clientId || !clientSecret) {
        return deny('no_credentials');
      }

      const exchange = deps.exchangeCode ?? exchangeAuthorizationCode;
      // Declared out here so the success redirect can name the company it was
      // granted for; a redirect that cannot say which company was authorized is
      // asking the operator to take the result on trust.
      let grantedRealm: string | null = null;
      try {
        const grant = await exchange(
          deps.httpTransport ?? httpTransport,
          { code: rawCode, realmId, clientId, clientSecret },
        );
        grantedRealm = grant.realmId;

        /*
          MERGED, not replaced — the operator's existing client id and secret must
          survive, or the connection that was just established is one restart away
          from being unable to refresh anything.
        */
        await deps.settingsService.updateAdaptor({
          realmId: grant.realmId,
          credentials: { refreshToken: grant.refreshToken },
        });
        /*
          NOT stamped here. `updateAdaptor` clears `verifiedAt` because a credential
          changed, and a grant is not yet proof the company answers: the adaptor is
          reset and the next probe or push decides, which is what makes the console's
          "verified" mean verified rather than merely authorized.
        */
        const registry = deps.adaptorRegistry ?? defaultAdaptorRegistry;
        registry.reset('quickbooks');
        await syncConfiguredAdaptor(registry, deps.settingsService);
      } catch (err) {
        // Nothing was written, so the stored configuration is exactly as it was.
        logger.warn(
          { organizationId: env.ORGANIZATION_ID, err },
          'QuickBooks authorization exchange failed',
        );
        return deny('exchange_failed');
      }

      return res.redirect(
        302,
        `${env.APP_BASE_URL.replace(/\/+$/, '')}/#/onboarding?connect=connected&realm=${encodeURIComponent(grantedRealm ?? '')}`,
      );
    }),
  };
}
