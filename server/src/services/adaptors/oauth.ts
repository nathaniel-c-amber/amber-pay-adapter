import { AdaptorAuthError } from './errors.js';
import type { AdaptorTransport } from '../../types/adaptor.js';

/**
 * OAuth token resolution for the QuickBooks adaptor.
 *
 * QuickBooks needs a BEARER TOKEN, not a client id. The previous `connect()`
 * only checked that a client id and secret were present and then marked the
 * adaptor connected with the literal string `'stub-token'` — a connection that
 * could never be used for anything, reported as success. This module resolves a
 * real token, and when it cannot, says which piece is missing and how to
 * provide it, because "adaptor is not connected" told an operator nothing about
 * a deployment whose credentials were in fact configured.
 *
 * Sources, in order:
 *   1. `accessToken`   — used as-is (short-lived; the operator can paste one).
 *   2. `refreshToken`  — exchanged for an access token at the token endpoint.
 *   3. neither         — an AdaptorAuthError naming the page that grants it.
 *
 * The exchange is deliberately part of `connect()` rather than of the transport
 * layer: it is authorization, and an expired token is the failure an operator
 * is most likely to meet.
 */

/** Intuit's OAuth 2.0 token endpoint. */
export const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

export interface OAuthCredentials {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  /** Overridden in tests; defaults to the live Intuit endpoint. */
  tokenUrl?: string | undefined;
}

export interface OAuthToken {
  accessToken: string;
  /** The endpoint may rotate the refresh token; callers should keep the newest. */
  refreshToken?: string;
}

/** Read a short, safe message out of a token-endpoint error body. */
function describeTokenError(body: unknown, status: number): string {
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
 * Resolve a usable access token, or throw an AdaptorAuthError that says exactly
 * what to configure. Note the two distinct failure modes: credentials MISSING
 * (nothing configured) versus credentials present but no GRANT (configured, not
 * yet authorized) — they need different fixes, so they get different messages.
 */
export async function resolveAccessToken(
  transport: AdaptorTransport,
  credentials: OAuthCredentials,
): Promise<OAuthToken> {
  const { clientId, clientSecret, accessToken, refreshToken } = credentials;

  if (!clientId || !clientSecret) {
    /*
      SAME RULE AS THE MESSAGE BELOW, for the same reason: the two application
      credentials are typed in the console, by ConfigPage's own link into the
      guided setup, so an operator reading this on a page of the console is told
      where to type them rather than which variables to export. Naming
      QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET here sent them to a
      deployment file they cannot see and a path the wizard replaced.
    */
    throw new AdaptorAuthError(
      'QuickBooks credentials are not configured: run the guided setup from System configuration and save the client ID and client secret',
    );
  }

  if (accessToken) {
    return { accessToken, ...(refreshToken ? { refreshToken } : {}) };
  }

  if (!refreshToken) {
    throw new AdaptorAuthError(
      /*
        THE FIX IS A PAGE, NOT AN ENVIRONMENT VARIABLE. The QuickBooks form collects
        no token — the grant comes from the browser authorization — so telling an
        operator to set QUICKBOOKS_ACCESS_TOKEN points them at the one path the
        console does not offer, and at a deployment file they cannot see from the
        page they are reading. The console already owns the fix, and this message
        reaches every surface the failure reaches (connector rows, the service
        window, findings), so naming the page and its button fixes them all at once.
      */
      'QuickBooks is configured but not authorized: approve the connection in System configuration (Re-authorize with QuickBooks)',
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await transport(
    'POST',
    credentials.tokenUrl ?? INTUIT_TOKEN_URL,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw new AdaptorAuthError(
      `QuickBooks token exchange failed (${describeTokenError(response.body, response.status)})`,
    );
  }

  const body = response.body as Record<string, unknown> | null;
  const minted = body?.['access_token'];
  if (typeof minted !== 'string' || minted === '') {
    throw new AdaptorAuthError('QuickBooks token exchange returned no access_token');
  }

  const rotated = body?.['refresh_token'];
  return { accessToken: minted, ...(typeof rotated === 'string' ? { refreshToken: rotated } : {}) };
}
