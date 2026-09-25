/* The QuickBooks OAuth 2.0 authorization-code flow, the shape Intuit's own
 * sample implements.
 *
 * THE POINT OF THE WHOLE EXERCISE. Until now an operator had to paste an access
 * token and a refresh token into the setup form. Both are write-only once stored,
 * so they could never be read back — which meant a deployment whose tokens needed
 * replacing could only be fixed by retyping values nobody had kept a copy of. The
 * stored-secret design is correct and stays; what changes is that the operator
 * never has to TYPE a token again.
 *
 * WHAT CLIENT ID AND SECRET DO AND DO NOT DO, which is the part most easily
 * misread. They identify the APP. On their own they cannot obtain a token: a grant
 * requires a human to log in at Intuit and consent, and the provider answers with
 * a one-time authorization code at the redirect URI. What the credentials then buy
 * is everything AFTER that — a refresh token can be exchanged indefinitely for new
 * access tokens (`oauth.ts`), so one consent buys perpetual operation and the
 * operator is out of the loop.
 *
 * THE ACCESS TOKEN IS NEVER PERSISTED. It lives for an hour; storing one is storing
 * something that is already expired by the time anybody looks at it, and it is the
 * value most likely to leak. Only the long-lived refresh token is written back, and
 * every rotation of it is persisted as it happens.
 */

import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { AdaptorAuthError } from './errors.js';
import type { AdaptorTransport } from '../../types/adaptor.js';

/** Where an operator is sent to log in and consent. */
export const INTUIT_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

/** The authorization-code grant, exchanged for tokens with the client secret. */
export const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

/**
 * Read AND write scopes.
 *
 * `accounting` alone is read-only; the ledger posts PAYMENT RECORDS, so the write
 * scope is required and requesting only the read one produces a token that
 * authorizes reads and then fails on the first push with an opaque 403. The sample
 * requests both for exactly this reason.
 */
export const QUICKBOOKS_SCOPES = ['com.intuit.quickbooks.accounting', 'com.intuit.quickbooks.payment'] as const;

export interface IntuitEndpoints {
  authUrl: string;
  tokenUrl: string;
}

/**
 * The endpoints to talk to.
 *
 * BOTH ARE THE SAME for sandbox and production. The environments are separate
 * tenants, but they are separated by the CLIENT ID — a sandbox app's id is not
 * valid at the production API, and Intuit rejects the token accordingly. So the
 * environment setting is still worth having (it is what lets the wizard state
 * which tenant it used, and what a future divergence would key off), but it does
 * not currently change a URL, and pretending otherwise here would be a lie in a
 * function whose whole job is to know where requests go.
 */
export function intuitEndpoints(): IntuitEndpoints {
  return { authUrl: INTUIT_AUTH_URL, tokenUrl: INTUIT_TOKEN_URL };
}

/**
 * Where Intuit will send the browser back.
 *
 * Derived from the deployment's own public address when not set explicitly, because
 * under one-deployment-per-organization the redirect URI is a property of the
 * deployment, not of the operator's machine — and a callback that resolves to
 * `localhost` will not work for anyone testing the tunnel.
 */
export function redirectUri(configured: string | undefined = env.QUICKBOOKS_REDIRECT_URI): string {
  if (configured && configured.length > 0) {
    return configured;
  }
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  return `${base}/api/v1/settings/adaptor/callback`;
}

/**
 * Build the URL the browser is sent to.
 *
 * `state` is REQUIRED and is not optional here even though the provider would
 * accept its absence: the provider does not care, but the callback's CSRF defence
 * does, and a signature is not something to add later when the attack is noticed.
 */
export function buildAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  endpoints?: IntuitEndpoints;
}): string {
  const url = new URL((params.endpoints ?? intuitEndpoints()).authUrl);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', QUICKBOOKS_SCOPES.join(' '));
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  return url.toString();
}

export interface AuthorizationGrant {
  /** Persisted: it is the only credential worth keeping. */
  refreshToken: string;
  /** The company the consenting user authorized — the QuickBooks "realm". */
  realmId: string;
  accessToken: string;
  /** ISO 8601, when the access token stops working. Informational only. */
  expiresAt: string | null;
}

/** A short, non-guessable value that distinguishes two simultaneous connect attempts. */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

function describeError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const detail = record['error_description'] ?? record['error'] ?? record['message'];
    if (typeof detail === 'string' && detail.trim() !== '') {
      return `status ${status}: ${detail}`;
    }
  }
  return `status ${status}`;
}

/**
 * Exchange an authorization code for tokens.
 *
 * A RESPONSE WITHOUT A REALM IS REFUSED rather than accepted with a blank company.
 * The realm is which company's books the deployment will post into, and Intuit
 * omits it when the consent covered only sign-in scopes. Writing a token with no
 * company produces a connection that authenticates and then 404s on every call —
 * a failure that surfaces as "QuickBooks answered 404" and points at the wrong thing
 * entirely.
 */
export async function exchangeAuthorizationCode(
  transport: AdaptorTransport,
  params: { code: string; realmId: string | undefined; clientId: string; clientSecret: string; tokenUrl?: string },
): Promise<AuthorizationGrant> {
  const { code, realmId, clientId, clientSecret } = params;
  if (!code) {
    throw new AdaptorAuthError('Intuit returned no authorization code');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await transport(
    'POST',
    params.tokenUrl ?? intuitEndpoints().tokenUrl,
    {
      grant_type: 'authorization_code',
      code,
      // MUST match the redirect URI sent on the authorization request, or Intuit
      // rejects the exchange as a redirect mismatch.
      redirect_uri: redirectUri(),
    },
    {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw new AdaptorAuthError(
      `QuickBooks rejected the authorization (${describeError(response.body, response.status)})`,
    );
  }

  const body = (response.body ?? {}) as Record<string, unknown>;
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new AdaptorAuthError('QuickBooks returned no access token for this authorization');
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    /*
      Without a refresh token the operator would have to consent AGAIN every hour,
      which is precisely the problem this flow was introduced to remove. Refusing
      here, loudly, is far better than a deployment that quietly needs a human every
      sixty minutes.
    */
    throw new AdaptorAuthError(
      'QuickBooks returned no refresh token; this authorization cannot be kept for ongoing use',
    );
  }
  if (typeof realmId !== 'string' || realmId.trim().length === 0) {
    throw new AdaptorAuthError(
      'QuickBooks did not return a company for this authorization. Consent must include the QuickBooks Accounting scope.',
    );
  }

  const expiresIn = typeof body['expires_in'] === 'number' ? (body['expires_in'] as number) : null;
  return {
    refreshToken,
    realmId: realmId.trim(),
    accessToken,
    expiresAt:
      expiresIn !== null ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
  };
}

/** The company a code was issued for, validated as a bare identifier. */
export function readRealmId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  // QuickBooks realm ids are numeric, but this is not asserted: an unexpected
  // shape is passed through to be reported by the exchange, which gives a far more
  // useful message than a local format complaint.
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : undefined;
}
