import {
  QUICKBOOKS_SCOPES,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  newNonce,
  readRealmId,
  redirectUri,
} from './intuitOAuth.service.js';
import { AdaptorAuthError } from './errors.js';
import { env } from '../../config/env.js';
import type { AdaptorResponse, AdaptorTransport } from '../../types/adaptor.js';

/*
  The authorization-code exchange is the step that can fail in four ways that all
  present to an operator as "QuickBooks did not work": the code is rejected, the
  redirect URI does not match, no refresh token comes back, and no company comes
  back. Each has a different fix, so each needs its own message and its own test.
*/

const okBody = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
};

function transportReturning(status: number, body: unknown): AdaptorTransport {
  return async () => ({ status, body }) as AdaptorResponse;
}

const parms = {
  code: 'auth-code-1',
  realmId: '9341457936805547',
  clientId: 'client-1',
  clientSecret: 'secret-1',
};

describe('buildAuthorizationUrl', () => {
  it('asks for a code, both QuickBooks scopes, and carries the state through', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'client-1',
        redirectUri: 'https://ledger.example.com/api/v1/settings/adaptor/callback',
        state: 'signed-state',
      }),
    );

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://ledger.example.com/api/v1/settings/adaptor/callback',
    );
    // Read AND write. The ledger POSTS payment records, so the write scope is
    // required — asking for only the read scope yields a token that authenticates
    // and then fails the first push with an opaque 403.
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...QUICKBOOKS_SCOPES]);
    expect(url.searchParams.get('scope')).toContain('com.intuit.quickbooks.payment');
  });
});

describe('redirectUri', () => {
  it('uses an explicitly configured URI when there is one', () => {
    expect(redirectUri('https://configured.example.com/cb')).toBe('https://configured.example.com/cb');
  });

  it('derives one from the deployment address otherwise', () => {
    const original = env.APP_BASE_URL;
    env.APP_BASE_URL = 'https://ledger.example.com/';
    try {
      // One deployment per organization: the redirect URI is a property of the
      // deployment's public address, not of the operator's machine.
      expect(redirectUri()).toBe('https://ledger.example.com/api/v1/settings/adaptor/callback');
    } finally {
      env.APP_BASE_URL = original;
    }
  });
});

describe('exchangeAuthorizationCode', () => {
  it('returns the refresh token, the company, and the access token', async () => {
    const grant = await exchangeAuthorizationCode(transportReturning(200, okBody), parms);

    expect(grant.refreshToken).toBe('refresh-1');
    expect(grant.realmId).toBe('9341457936805547');
    expect(grant.accessToken).toBe('access-1');
    expect(grant.expiresAt).toBeTruthy();
  });

  it('sends the code with Basic auth and a matching redirect URI', async () => {
    const seen: Array<{ method: string; url: string; body: unknown; headers?: Record<string, string> }> = [];
    const transport: AdaptorTransport = async (method, url, body, headers) => {
      seen.push({ method, url, body, ...(headers ? { headers } : {}) });
      return { status: 200, body: okBody };
    };

    await exchangeAuthorizationCode(transport, parms);

    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toContain('tokens/bearer');
    // Form-encoded, NOT JSON: the token endpoint rejects a JSON body with a 400
    // whose message says nothing about the real problem.
    expect(seen[0]?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = seen[0]?.body as Record<string, string>;
    expect(body['grant_type']).toBe('authorization_code');
    expect(body['code']).toBe('auth-code-1');
    // It must be byte-identical to the one sent on the authorization request, or
    // Intuit refuses the exchange as a redirect mismatch.
    expect(body['redirect_uri']).toBe(redirectUri());
    expect(Buffer.from(
      (seen[0]?.headers?.['Authorization'] ?? '').replace('Basic ', ''),
      'base64',
    ).toString('utf8')).toBe('client-1:secret-1');
  });

  it('names the redirect URI it sent when Intuit says that URI is not registered', async () => {
    /*
      ★ THE MESSAGE IS THE FIX. `invalid_redirect_uri` has exactly one remedy —
      register this exact string — so a message that says "rejected" and stops
      leaves the operator guessing at scheme, port and trailing slash, which are
      the only things that differ between a working and a failing value.
    */
    const transport = transportReturning(400, {
      error: 'invalid_redirect_uri',
      error_description: 'Invalid redirect URI',
    });

    await expect(exchangeAuthorizationCode(transport, parms)).rejects.toThrow(
      new RegExp(`register exactly that value`, 'i'),
    );
    await expect(exchangeAuthorizationCode(transport, parms)).rejects.toThrow(
      new RegExp(redirectUri().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('refuses a grant with no refresh token, rather than storing something that dies hourly', async () => {
    const transport = transportReturning(200, { access_token: 'access-1', expires_in: 3600 });

    await expect(exchangeAuthorizationCode(transport, parms)).rejects.toThrow(/no refresh token/i);
    // Without a refresh token the operator would have to consent again every hour,
    // which is the exact problem this flow was introduced to remove.
  });

  it('refuses a grant with no company, rather than storing a token that 404s on every call', async () => {
    const transport = transportReturning(200, okBody);

    await expect(
      exchangeAuthorizationCode(transport, { ...parms, realmId: undefined }),
    ).rejects.toThrow(/did not return a company/i);
    // A token with no realm authenticates fine and then fails every API call, which
    // surfaces as "QuickBooks answered 404" and points at entirely the wrong thing.
  });

  it('surfaces the provider message when the code is rejected', async () => {
    const transport = transportReturning(400, {
      error: 'invalid_grant',
      error_description: 'Token invalid',
    });

    await expect(exchangeAuthorizationCode(transport, parms)).rejects.toThrow(/Token invalid/);
  });

  it('refuses an empty code before making a request', async () => {
    let called = false;
    const transport: AdaptorTransport = async () => {
      called = true;
      return { status: 200, body: okBody };
    };

    await expect(exchangeAuthorizationCode(transport, { ...parms, code: '' })).rejects.toBeInstanceOf(
      AdaptorAuthError,
    );
    expect(called).toBe(false);
  });
});

describe('readRealmId', () => {
  it('accepts a plain identifier and rejects empty or absurd input', () => {
    expect(readRealmId('9341457936805547')).toBe('9341457936805547');
    expect(readRealmId('  123  ')).toBe('123');
    expect(readRealmId('')).toBeUndefined();
    expect(readRealmId(undefined)).toBeUndefined();
    expect(readRealmId({ evil: true })).toBeUndefined();
    // Over-long input is not a realm, and passing it on would put junk in a column
    // every other query filters on.
    expect(readRealmId('x'.repeat(200))).toBeUndefined();
  });
});

describe('newNonce', () => {
  it('is unpredictable and distinct per call', () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});
