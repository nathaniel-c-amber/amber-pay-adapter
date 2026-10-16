/* Which client id and secret one adaptor is configured with, resolved once.
 *
 * STORED FIRST, ENVIRONMENT SECOND — and the second half is TRANSITIONAL. A
 * deployment configured entirely from `.env` keeps working unchanged, including a
 * sandbox base URL and a hand-pasted access token, while the onboarding wizard
 * gradually takes ownership of those values. Removing the fallback before the
 * wizard can set every field would break every existing install on upgrade,
 * which is a worse failure than having two sources for a while. When the wizard
 * owns all of them, delete `environmentAdaptorCredentials` and its fields from
 * the env schema. The token pair's half of that statement lives with the schema
 * that owns it (`config/env.ts`), which is the other place to look before
 * changing the precedence here.
 *
 * IT IS A LEAF, and that is the reason it is its own file rather than another
 * export from `credentials.provider.ts`. This module answers a question the
 * SETTINGS SERVICE has to ask before it can store anything, so a resolver that
 * reached for `settings.service` would close an import cycle
 * (`settings.service` → `credentials.provider` → `settings.service`) — and that
 * cycle is not merely untidy: it drags `getRepositories()` and the adaptor
 * registry into a unit test of a merge rule that needs neither. Nothing here may
 * import a service or a repository; the environment and the shared types are the
 * whole of what this module knows.
 */

import { env } from '../../config/env.js';
import type { AdaptorCredentials, AdaptorId } from '../../types/adaptor.js';

/**
 * The slice of the environment this module reads.
 *
 * A `Pick`, not `typeof env`, for two reasons. A caller injecting a fixture
 * should not have to construct a whole deployment configuration to describe a
 * merge, and the set of variables that can reach credential resolution should be
 * readable in one line — a new `env.QUICKBOOKS_*` cannot silently start
 * configuring an adaptor without appearing here and in the schema comment that
 * justifies it.
 *
 * The transitional TOKEN pair is deliberately NOT in it. Those two variables are
 * deprecated, they are consumed only by the provider that connects an adaptor,
 * and putting them in a type named for application credentials would invite the
 * browser-authorization callers — which need a client id and a secret and
 * nothing else — to carry a bearer token they never use.
 */
export type AppCredentialEnv = Pick<
  typeof env,
  | 'QUICKBOOKS_CLIENT_ID'
  | 'QUICKBOOKS_CLIENT_SECRET'
  | 'QUICKBOOKS_BASE_URL'
  | 'QUICKBOOKS_REALM_ID'
  | 'SAGE_CLIENT_ID'
  | 'SAGE_CLIENT_SECRET'
  | 'SAGE_BASE_URL'
>;

/**
 * Env-sourced credentials for one adaptor, until the wizard owns every field.
 *
 * MOVED here from `credentials.provider.ts` rather than rewritten, because the
 * provider now needs this leaf for the same question the settings service needs
 * it for. Every field is passed through as-is, including the ones that are
 * `undefined`: the merge above decides what is present, and a value dropped here
 * would be a value a caller could not tell apart from one that was never
 * configured.
 */
export function environmentAdaptorCredentials(
  id: AdaptorId,
  environment: AppCredentialEnv = env,
): AdaptorCredentials {
  if (id === 'quickbooks') {
    return {
      clientId: environment.QUICKBOOKS_CLIENT_ID,
      clientSecret: environment.QUICKBOOKS_CLIENT_SECRET,
      baseUrl: environment.QUICKBOOKS_BASE_URL,
      realmId: environment.QUICKBOOKS_REALM_ID,
      /*
        Read from `env` rather than from `environment`, because the deprecated
        token pair is not part of `AppCredentialEnv` (see that type). In production
        the two are the same object: `credentials.provider.ts` passes `env`. A test
        that injects a fixture to exercise the merge below gets `{}` for the
        application credentials and the suite's transitional token pair, which is
        the same pair the provider merges over.
      */
      accessToken: env.QUICKBOOKS_ACCESS_TOKEN,
      refreshToken: env.QUICKBOOKS_REFRESH_TOKEN,
    };
  }
  return {
    clientId: environment.SAGE_CLIENT_ID,
    clientSecret: environment.SAGE_CLIENT_SECRET,
    baseUrl: environment.SAGE_BASE_URL,
  };
}

/**
 * The first of two values that actually carries something.
 *
 * A field that is present but BLANK is the absence of a value, not a value. The
 * console cannot pre-fill a stored secret, so every form submits an empty string
 * for each field the operator did not retype; trusting those would erase a
 * credential nobody touched, which is why the console merges rather than replaces
 * (`settings.service.mergeCredentials`). Whitespace counts as blank for the same
 * reason a padded input reaches a `text` field unchanged.
 *
 * The value is returned AS GIVEN, not trimmed: trimming here would silently
 * rewrite what an operator saved, and the field it lands in — an authorization
 * URL parameter — is far better served by the exact stored string.
 */
function firstPresent(stored: unknown, fromEnvironment: string | undefined): string | undefined {
  if (typeof stored === 'string' && stored.trim() !== '') {
    return stored;
  }
  return typeof fromEnvironment === 'string' && fromEnvironment.trim() !== ''
    ? fromEnvironment
    : undefined;
}

/**
 * THE merge rule for the two application credentials: stored wins per field,
 * environment fills the gaps.
 *
 * `null` unless BOTH halves resolve, because half a client credential is not a
 * weaker version of one — it cannot produce an authorization URL, and the
 * console asks for the missing half by name. Returning a partial pair would let
 * a caller build a link Intuit rejects, with the error naming a parameter the
 * operator never saw.
 *
 * `stored` MUST belong to `id`. Isolation between adaptors is the caller's rule,
 * not this one's: whoever reads the settings row already knows which adaptor it
 * is for, and the two systems' credentials are entered and verified separately.
 * Passing one system's stored fields in for the other is a mistake no merge can
 * detect — `credentials.provider.ts` checks `configured.id` before it gets here,
 * and the settings service is expected to do the same.
 */
export function resolveAppCredentials(
  id: AdaptorId,
  stored: Record<string, unknown> | null | undefined,
  environment: AppCredentialEnv = env,
): { clientId: string; clientSecret: string } | null {
  const fallback = environmentAdaptorCredentials(id, environment);
  const clientId = firstPresent(stored?.['clientId'], fallback.clientId);
  const clientSecret = firstPresent(stored?.['clientSecret'], fallback.clientSecret);

  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}