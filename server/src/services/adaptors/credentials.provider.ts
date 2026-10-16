/* Where an adaptor's credentials come from, and the only place that knows.
 *
 * The adaptors read no environment (see `AdaptorCredentials`), so something has
 * to bridge the deployment's configuration to the `connect` call. Keeping that
 * to one file is the point: the alternative is a `env.QUICKBOOKS_*` reference
 * drifting back into an adaptor the next time one is touched, which is exactly
 * the coupling this change removes.
 *
 * STORED FIRST, ENVIRONMENT SECOND — and the second half is TRANSITIONAL, for the
 * reasons stated where the fallback now lives: `appCredentials.ts` holds the
 * environment-side values and the rationale for keeping them, in a leaf that
 * does not import this file. Read it before changing the precedence below.
 *
 * IT ALSO PERSISTS A ROTATION. Intuit invalidates a refresh token as it spends
 * it, so the value handed back has to be written somewhere or the next process
 * start presents a token that has already been used — which looks like
 * flakiness rather than like a bug, and only one token-lifetime after any
 * restart.
 */

import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { settingsService } from '../settings/settings.service.js';
import { environmentAdaptorCredentials } from './appCredentials.js';
import type {
  AccountingAdaptor,
  AdaptorCredentials,
  AdaptorId,
  ConnectResult,
} from '../../types/adaptor.js';

/**
 * Resolve the credentials to connect an adaptor with.
 *
 * Resolves to `{}` rather than throwing when nothing is configured, because the
 * ADAPTOR's own error names which piece is missing — "credentials are not
 * configured" versus "configured but not authorized" — and that distinction is
 * the one an operator acts on. A generic error raised here would flatten it.
 */
export type AdaptorCredentialsProvider = (id: AdaptorId) => Promise<AdaptorCredentials>;

/**
 * Whether the STORED set for this adaptor carries a grant of its own.
 *
 * A stored refresh token IS the browser grant: `oauth.ts` exchanges it for an
 * access token and the replacement is written back by `persistRotation`. A value
 * that is only whitespace is not a grant, and treating it as one would be worse
 * than ignoring it — `oauth.ts` would try to exchange it, and the environment's
 * working token would already have been suppressed. `definedFields` cannot be
 * used for this test: it admits any non-empty string, padding included.
 */
function hasStoredGrant(fields: Record<string, string>): boolean {
  return typeof fields.refreshToken === 'string' && fields.refreshToken.trim() !== '';
}

/** Drop absent and empty values, so a stored field cannot blank out a real one. */
function definedFields(credentials: AdaptorCredentials): Record<string, string> {
  return Object.fromEntries(
    Object.entries(credentials).filter(
      ([, value]) => typeof value === 'string' && value.length > 0,
    ),
  ) as Record<string, string>;
}

export async function credentialsForAdaptor(id: AdaptorId): Promise<AdaptorCredentials> {
  // `env` passed explicitly rather than defaulted: this module has no injectable
  // environment of its own, and the call is the place to look when a deployment's
  // credentials come from somewhere unexpected. The leaf's second argument exists
  // for tests, which cannot mutate `process.env` after `config/env.ts` has parsed
  // it at import.
  const fallback = environmentAdaptorCredentials(id, env);

  let configured;
  try {
    configured = (await settingsService.resolveCredentials()).adaptor;
  } catch (err) {
    // A stored credential that cannot be decrypted must not make the probe
    // crash: the environment is still a valid source, and the unreadable row is
    // reported separately by the settings read.
    logger.warn({ adaptor: id, err }, 'Stored credentials unreadable; falling back to environment');
    return fallback;
  }

  if (!configured || configured.id !== id) {
    // Nothing stored for THIS adaptor — either nothing is configured yet, or the
    // other accounting system was chosen.
    return fallback;
  }

  const stored = definedFields(configured.fields);
  const resolved: AdaptorCredentials = {
    ...fallback,
    ...stored,
    ...(configured.realmId ? { realmId: configured.realmId } : {}),
    ...(configured.baseUrl ? { baseUrl: configured.baseUrl } : {}),
  };

  /*
    A COMPLETED GRANT SUPERSEDES A PASTED TOKEN.

    `oauth.ts` returns `accessToken` as-is when there is one, so left merged,
    `env.QUICKBOOKS_ACCESS_TOKEN` outranks a grant the operator just completed in
    the browser: the callback stores a refresh token and deliberately no access
    token, so the deployment would report connected while authenticating with
    whatever was pasted into `.env` hours or days earlier — a green tick over a
    grant that was never exercised, and a failure that first appears when Intuit
    expires the pasted token, long after the re-authorization meant to replace it.

    The guard is the STORED side only. A stored set with an access token of its own
    keeps it — nothing is dropped — and with no stored grant the transitional
    environment pair remains the whole answer, because suppressing it there would
    break every `.env`-configured install on upgrade. That is the only trade-off,
    and it is deliberate: an operator who sets both gets the stored grant, which is
    the one that rotates and persists (`persistRotation`), while a pasted token can
    never be renewed and is spent one restart later. An operator who wanted the
    paste to keep winning has to clear the stored grant rather than edit `.env`.
  */
  if (hasStoredGrant(stored) && stored['accessToken'] === undefined) {
    delete resolved.accessToken;
  }

  return resolved;
}

/**
 * Write back a credential the upstream rotated, if there is anywhere to write it.
 *
 * Extracted from `connectAdaptor` because a rotation is not tied to connecting:
 * `QuickBooksAdaptor.healthCheck` re-mints when its access token expires, and
 * that mint spends the refresh token exactly as thoroughly as a boot. A
 * rotation persisted only on the boot path leaves the process healthy and the
 * NEXT RESTART dead — the deployment works right up until it is redeployed and
 * then cannot connect with "Incorrect or invalid refresh token", which reads as
 * a credential problem and is not one.
 */
export async function persistRotation(
  adaptorId: AdaptorId,
  rotated: AdaptorCredentials | undefined,
): Promise<void> {
  if (!rotated) return;

  const stored = (await settingsService.resolveCredentials()).adaptor;
  if (!stored || stored.id !== adaptorId) {
    /*
      The credentials came from the ENVIRONMENT, so there is nothing to update.
      Writing the rotated token into the store here would invent a stored
      credential set out of an env fallback, and no later reader could tell which
      of the two sources was authoritative.

      This is the transitional state an env-configured deployment lives in, and
      it is a REAL limitation rather than a warning to shrug off: Intuit spends
      a refresh token on every exchange, so an env-sourced token works until the
      process restarts and then does not. The fix is a stored credential, which
      is what the onboarding wizard writes.
    */
    logger.warn(
      { adaptor: adaptorId },
      'Upstream rotated a credential, but the credentials come from the environment: the rotated value cannot be persisted, so a restart will present a spent token',
    );
    return;
  }

  await settingsService.storeRotatedCredentials({
    ...stored.fields,
    ...definedFields(rotated),
  });
}

/**
 * Connect an adaptor, and persist anything the upstream rotated.
 *
 * The single entry point for connecting, so no call site can connect with
 * credentials that skipped the provider or drop a rotation on the floor.
 */
export async function connectAdaptor(adaptor: AccountingAdaptor): Promise<void> {
  const result = await adaptor.connect(await credentialsForAdaptor(adaptor.id));
  await persistRotation(adaptor.id, result?.rotated);
}

/**
 * The rotation sink for an adaptor that mints on its own.
 *
 * Handed to the adaptor's constructor so a `healthCheck` re-mint is persisted by
 * whoever wired the adaptor, rather than the adaptor reaching into settings
 * itself — an adaptor that persisted its own credentials would reintroduce the
 * dependency on configuration that injected credentials exist to remove.
 */
export function rotationSink(adaptorId: AdaptorId) {
  return async (result: ConnectResult | void): Promise<void> => {
    await persistRotation(adaptorId, result?.rotated);
  };
}
