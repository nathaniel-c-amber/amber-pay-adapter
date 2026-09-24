import { z } from 'zod';
import type { RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { UnauthorizedError, ValidationError } from '../utils/errors.js';
import { verifyAdaptorConnection } from '../services/settings/verify.service.js';
import { syncConfiguredAdaptor } from '../services/adaptors/activeAdaptor.service.js';
import { adaptorRegistry as defaultAdaptorRegistry } from '../services/adaptors/registry.js';
import type { SettingsService } from '../services/settings/settings.service.js';
import type { AdaptorRegistry } from '../services/adaptors/registry.js';
import type { AdaptorCredentials } from '../types/adaptor.js';
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
    credentials: z.record(z.string()).nullable().optional(),
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
}

export interface SettingsController {
  /** GET /api/v1/settings — presence and last-four only, never a value. */
  get: RequestHandler;
  /** PUT /api/v1/settings/gateway */
  updateGateway: RequestHandler;
  /** PUT /api/v1/settings/adaptor */
  updateAdaptor: RequestHandler;
  /** PUT /api/v1/settings/preferences */
  updatePreferences: RequestHandler;
  /** POST /api/v1/settings/adaptor/verify — transient, writes nothing it tested. */
  verifyAdaptor: RequestHandler;
  /** POST /api/v1/settings/complete — stamps the first-run flag, idempotent. */
  complete: RequestHandler;
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
  };
}
