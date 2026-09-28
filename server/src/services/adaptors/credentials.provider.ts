/* Where an adaptor's credentials come from, and the only place that knows.
 *
 * The adaptors read no environment (see `AdaptorCredentials`), so something has
 * to bridge the deployment's configuration to the `connect` call. Keeping that
 * to one file is the point: the alternative is a `env.QUICKBOOKS_*` reference
 * drifting back into an adaptor the next time one is touched, which is exactly
 * the coupling this change removes.
 *
 * STORED FIRST, ENVIRONMENT SECOND — and the second half is TRANSITIONAL. A
 * deployment configured entirely from `.env` keeps working unchanged, including
 * a sandbox base URL and a hand-pasted access token, while the onboarding wizard
 * gradually takes ownership of those values. Removing the fallback before the
 * wizard can set every field would break every existing install on upgrade,
 * which is a worse failure than having two sources for a while. When the wizard
 * owns all of them, delete `fromEnvironment` and its fields from the env schema.
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

/** Deployment-level fallbacks, until the wizard owns every field. */
function fromEnvironment(id: AdaptorId): AdaptorCredentials {
  if (id === 'quickbooks') {
    return {
      clientId: env.QUICKBOOKS_CLIENT_ID,
      clientSecret: env.QUICKBOOKS_CLIENT_SECRET,
      baseUrl: env.QUICKBOOKS_BASE_URL,
      realmId: env.QUICKBOOKS_REALM_ID,
      accessToken: env.QUICKBOOKS_ACCESS_TOKEN,
      refreshToken: env.QUICKBOOKS_REFRESH_TOKEN,
    };
  }
  return {
    clientId: env.SAGE_CLIENT_ID,
    clientSecret: env.SAGE_CLIENT_SECRET,
    baseUrl: env.SAGE_BASE_URL,
  };
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
  const fallback = fromEnvironment(id);

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

  return {
    ...fallback,
    ...definedFields(configured.fields),
    ...(configured.realmId ? { realmId: configured.realmId } : {}),
    ...(configured.baseUrl ? { baseUrl: configured.baseUrl } : {}),
  };
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
