import request from 'supertest';
import { createApp } from '../app.js';
import { SettingsService } from '../services/settings/settings.service.js';
import { InMemorySettingsRepository } from '../repositories/inMemory.js';
import { AdaptorRegistry } from '../services/adaptors/registry.js';
import { QuickBooksAdaptor } from '../services/adaptors/quickbooks.service.js';
import { issueOAuthState } from '../utils/oauthState.js';
import { issueAccessToken } from '../utils/tokens.js';
import { env } from '../config/env.js';
import type { PolicyAttribute } from '../types/auth.js';
import type { AdaptorTransport } from '../types/adaptor.js';

/*
  The Intuit connect flow, tested as an ATTACK SURFACE rather than as a feature.

  The callback is reachable with NO SESSION, because Intuit redirects the browser
  and no bearer token travels with that navigation. Everything standing between a
  stranger and this deployment's QuickBooks credentials is the `state` parameter, so
  every case below is a variation on "can someone reach the exchange without one we
  minted".
*/

const systemAdmin: PolicyAttribute[] = [
  { scope: 'system', organizationId: 'org-1', actions: ['admin'] },
];
const systemReader: PolicyAttribute[] = [
  { scope: 'system', organizationId: 'org-1', actions: ['read'] },
];

function bearer(policy: PolicyAttribute[]): string {
  return `Bearer ${issueAccessToken({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@example.com',
    policyAttributes: policy,
  })}`;
}

const CALLBACK = '/api/v1/settings/adaptor/callback';
const CONNECT = '/api/v1/settings/adaptor/connect';

function stubTransport(
  body: unknown,
  status = 200,
): { transport: AdaptorTransport; calls: () => number } {
  let calls = 0;
  return {
    transport: async () => {
      calls += 1;
      return { status, body };
    },
    calls: () => calls,
  };
}

function harness(options: { transport?: AdaptorTransport } = {}) {
  const repository = new InMemorySettingsRepository();
  const settingsService = new SettingsService(repository);
  const registry = new AdaptorRegistry();
  registry.register('quickbooks', () => new QuickBooksAdaptor());
  const stub = stubTransport({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
  });
  return {
    app: createApp({
      settings: {
        settingsService,
        adaptorRegistry: registry,
        /*
          NEVER the live provider. A test that reaches Intuit is a test that fails
          for reasons unrelated to the code, and one that passes only when the
          network happens to be up.
        */
        httpTransport: options.transport ?? stub.transport,
      },
    }),
    settingsService,
    transportCalls: stub.calls,
  };
}

/** A transport that refuses, standing in for Intuit rejecting the code. */
function rejectingTransport(): AdaptorTransport {
  return async () => ({ status: 400, body: { error: 'invalid_grant' } });
}

async function seedClientCredentials(settingsService: SettingsService): Promise<void> {
  await settingsService.updateAdaptor({
    id: 'quickbooks',
    credentials: { clientId: 'client-1', clientSecret: 'secret-1' },
  });
}

function locationOf(res: request.Response): string {
  return String(res.headers['location'] ?? '');
}

describe('GET /settings/adaptor/connect', () => {
  it('refuses a caller with no session', async () => {
    const { app } = harness();

    const res = await request(app).get(CONNECT);

    expect(res.status).toBe(401);
  });

  it('refuses a read-only holder, because it reads stored credentials to build the URL', async () => {
    const { app } = harness();

    const res = await request(app).get(CONNECT).set('Authorization', bearer(systemReader));

    expect(res.status).toBe(403);
  });

  it('explains what to do when the client credentials are not saved yet', async () => {
    const { app } = harness();

    const res = await request(app).get(CONNECT).set('Authorization', bearer(systemAdmin));

    // 400 rather than a redirect to a provider that will reject the request, so the
    // operator is told the actual problem instead of meeting Intuit's own error.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/client id and client secret first/i);
  });
});

describe('the callback is the attack surface', () => {
  it('does NOT exchange anything when the state is missing', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);
    const before = await settingsService.resolveCredentials();

    const res = await request(app).get(`${CALLBACK}?code=attacker-code&realmId=12345`);

    expect(res.status).toBe(302);
    expect(locationOf(res)).toContain('connect=error');
    // The whole point: no grant, no write, and nothing in what the caller is told
    // that distinguishes "no state" from "bad state".
    const after = await settingsService.resolveCredentials();
    expect(after.adaptor?.fields).toEqual(before.adaptor?.fields);
  });

  it('does NOT exchange anything when the state is forged', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);

    const res = await request(app).get(
      `${CALLBACK}?code=attacker-code&realmId=12345&state=not-a-real-state`,
    );

    expect(locationOf(res)).toContain('reason=unverified');
    expect((await settingsService.resolveCredentials()).adaptor?.fields['refreshToken']).toBeUndefined();
  });

  it('refuses a state that was issued for the other accounting system', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);

    // A flow started while Sage was selected must not complete into a QuickBooks
    // row, or the deployment ends up pointed at a system nobody entered credentials
    // for.
    const sageState = issueOAuthState('sage', 'n');
    const res = await request(app).get(`${CALLBACK}?code=c&realmId=1&state=${sageState}`);

    expect(locationOf(res)).toContain('reason=unverified');
    expect((await settingsService.resolveCredentials()).adaptor?.fields['refreshToken']).toBeUndefined();
  });

  it('reports a declined consent as a decline, not as a server error', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);
    const state = issueOAuthState('quickbooks', 'n');

    const res = await request(app).get(`${CALLBACK}?error=access_denied&state=${state}`);

    // Intuit sends this when a person clicks Cancel. "The provider is broken" is the
    // wrong lesson; "you declined" is the right one.
    expect(locationOf(res)).toContain('reason=declined');
  });

  it('never puts a token in the redirect URL', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);
    const state = issueOAuthState('quickbooks', 'n');

    const res = await request(app).get(`${CALLBACK}?code=code-1&realmId=934145&state=${state}`);

    // A token in a redirect lands in browser history, in Referer on the next
    // navigation, and in every proxy log along the way.
    expect(locationOf(res)).not.toContain('access-1');
    expect(locationOf(res)).not.toContain('refresh-1');
    expect(locationOf(res)).toContain('connect=connected');
  });

  it('redirects back to the DEPLOYMENT address, not to whatever the request claims', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);
    const state = issueOAuthState('quickbooks', 'n');

    const res = await request(app)
      .get(`${CALLBACK}?code=code-1&realmId=1&state=${state}`)
      .set('Host', 'evil.example.com');

    // An open redirect here would turn the connect flow into a phishing primitive: a
    // real Intuit URL that bounces the operator somewhere of the caller's choosing.
    expect(locationOf(res)).toContain(env.APP_BASE_URL);
    expect(locationOf(res)).not.toContain('evil.example.com');
  });
});

describe('a completed connect', () => {
  it('stores the refresh token and company, and keeps the client credentials', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);
    const state = issueOAuthState('quickbooks', 'n');

    const res = await request(app).get(
      `${CALLBACK}?code=code-1&realmId=9341457936805547&state=${state}`,
    );

    expect(locationOf(res)).toContain('connect=connected');
    const stored = await settingsService.resolveCredentials();
    expect(stored.adaptor?.fields['refreshToken']).toBe('refresh-1');
    expect(stored.adaptor?.realmId).toBe('9341457936805547');
    // The operator's client id and secret must survive, or the connection just
    // established cannot refresh anything on the next exchange.
    expect(stored.adaptor?.fields['clientId']).toBe('client-1');
    expect(stored.adaptor?.fields['clientSecret']).toBe('secret-1');
  });

  it('does NOT claim the connection is verified, because a grant is not proof', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);
    const state = issueOAuthState('quickbooks', 'n');

    await request(app).get(`${CALLBACK}?code=code-1&realmId=934145&state=${state}`);

    // `verifiedAt` means "the company answered". A token exists; nothing has been
    // asked. The next probe or push decides, which is what makes the console's tick
    // mean verified rather than merely authorized.
    expect((await settingsService.getSettings()).verifiedAt).toBeNull();
  });

  it('leaves stored configuration untouched when the exchange fails', async () => {
    const { app, settingsService } = harness({ transport: rejectingTransport() });
    await seedClientCredentials(settingsService);
    const state = issueOAuthState('quickbooks', 'n');

    const res = await request(app).get(`${CALLBACK}?code=code-1&realmId=934145&state=${state}`);

    expect(locationOf(res)).toContain('reason=exchange_failed');
    const stored = await settingsService.resolveCredentials();
    expect(stored.adaptor?.fields['refreshToken']).toBeUndefined();
    expect(stored.adaptor?.fields['clientId']).toBe('client-1');
  });

  it('never reaches the provider when the state check fails', async () => {
    // The single most important assertion in this file, and the reason the state is
    // verified before the code is read: a stranger with a forged callback must not
    // be able to make this deployment talk to Intuit at all.
    const stub = stubTransport({ access_token: 'a', refresh_token: 'r' });
    const { app, settingsService } = harness({ transport: stub.transport });
    await seedClientCredentials(settingsService);

    await request(app).get(`${CALLBACK}?code=attacker&realmId=1&state=forged`);
    await request(app).get(`${CALLBACK}?code=attacker&realmId=1`);

    expect(stub.calls()).toBe(0);
  });
});
