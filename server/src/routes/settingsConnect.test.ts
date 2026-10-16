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

/**
 * The environment the settings service resolves the SECOND half of the credential
 * pair from.
 *
 * Typed as the service's own constructor parameter rather than as a local shape, so
 * the fixture follows the production seam and cannot drift from it. It exists at
 * all because `setup-env.cjs` hands every test QuickBooks credentials in
 * `process.env` and `config/env.ts` parses `process.env` once at import — without an
 * injected source, "the store is empty" can no longer be arranged, and this file's
 * original 400 case asserted a stored-only rule against a fixture that was never
 * stored-only. `setup-env.cjs` is deliberately not touched: it is the whole suite's
 * transition-era default, and one case here needs the other half.
 */
type FixtureEnvironment = ConstructorParameters<typeof SettingsService>[1];

/** A deployment whose client credentials are configured from nowhere. */
function emptyEnvironment(): FixtureEnvironment {
  return {};
}

/** A deployment whose whole QuickBooks configuration lives in `.env`. */
const SANDBOX_ENVIRONMENT: FixtureEnvironment = {
  QUICKBOOKS_CLIENT_ID: 'env-client-id',
  QUICKBOOKS_CLIENT_SECRET: 'env-client-secret',
  QUICKBOOKS_BASE_URL: 'https://sandbox-quickbooks.api.intuit.com',
  QUICKBOOKS_REALM_ID: undefined,
  SAGE_CLIENT_ID: undefined,
  SAGE_CLIENT_SECRET: undefined,
  SAGE_BASE_URL: undefined,
};

function harness(
  options: { transport?: AdaptorTransport; environment?: FixtureEnvironment } = {},
) {
  const repository = new InMemorySettingsRepository();
  /*
    The service the app is BUILT WITH is the fixture's, so the harness instance is
    the one that resolves credentials. Constructed with the environment injected
    rather than reaching for `env` inside a handler, which is what lets one case
    describe a deployment the suite as a whole cannot be.
  */
  const settingsService = new SettingsService(repository, options.environment ?? env);
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

/**
 * Run a case as a deployment with NO `SECRETS_KEY` — the state that makes the
 * store refuse a credential write, and the one that silently loses a refresh token
 * if an authorization code is spent without somewhere to put the result.
 *
 * `env` is parsed once at import (`config/env.ts`), so the key is removed from the
 * parsed object rather than from `process.env`, and restored in a `finally` so
 * nothing leaks into the next case in this file.
 */
async function withoutSecretsKey(run: () => Promise<void>): Promise<void> {
  const key = env.SECRETS_KEY;
  (env as { SECRETS_KEY?: string }).SECRETS_KEY = undefined;
  try {
    await run();
  } finally {
    (env as { SECRETS_KEY?: string }).SECRETS_KEY = key;
  }
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

/**
 * The wizard's step BEFORE credentials, and left there: QuickBooks is chosen and
 * no credential has been typed.
 *
 * This is the state the stored-then-environment rule exists for. The choice is
 * still stored because a stored credential set is only usable once the row says
 * whose it is — a credential blob with no owner is the other system's, and both
 * the resolver and `credentials.provider.ts` refuse to read it.
 */
async function chooseQuickbooksOnly(settingsService: SettingsService): Promise<void> {
  await settingsService.updateAdaptor({ id: 'quickbooks' });
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

  it('refuses a read-only holder, because it reads the deployment client credentials to build the URL', async () => {
    const { app } = harness();

    const res = await request(app).get(CONNECT).set('Authorization', bearer(systemReader));

    expect(res.status).toBe(403);
  });

  it('explains what to do when the client credentials are not saved yet', async () => {
    /*
      THE ENVIRONMENT IS EMPTY HERE, and it has to be. `setup-env.cjs` gives every
      test QuickBooks credentials in `process.env`, so an empty STORE no longer
      means an unconfigured deployment — it means the second half of the
      stored-then-environment rule. Asserting the 400 against the default harness
      would have been asserting the opposite of what it claimed.
    */
    const { app } = harness({ environment: emptyEnvironment() });

    const res = await request(app).get(CONNECT).set('Authorization', bearer(systemAdmin));

    // 400 rather than a URL pointing at a provider that will reject the request, so
    // the operator is told the actual problem instead of meeting Intuit's own error.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/client id and client secret first/i);
    expect(res.body.authorizationUrl).toBeUndefined();
  });

  it('builds the authorization URL from the ENVIRONMENT when nothing is stored', async () => {
    /*
      THE BUG THIS EXISTS FOR. The console tells an operator whose deployment is
      configured entirely from `.env` to click "Re-authorize with QuickBooks", and a
      store-only read meant that button could only ever answer 400 — the deployment
      could not start or complete an authorization at all.
    */
    const { app } = harness();

    const res = await request(app).get(CONNECT).set('Authorization', bearer(systemAdmin));

    expect(res.status).toBe(200);
    const url = new URL(String(res.body.authorizationUrl));
    expect(url.searchParams.get('client_id')).toBe(env.QUICKBOOKS_CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('never puts the environment client SECRET in the URL it hands back', async () => {
    const { app } = harness();

    const res = await request(app).get(CONNECT).set('Authorization', bearer(systemAdmin));

    // The browser is about to be sent to this URL, and the value is one the
    // operator never typed anywhere the console could hold it.
    expect(String(res.body.authorizationUrl)).not.toContain(env.QUICKBOOKS_CLIENT_SECRET);
    expect(JSON.stringify(res.body)).not.toContain(env.QUICKBOOKS_CLIENT_SECRET);
  });

  it('refuses to START a consent a deployment cannot store', async () => {
    /*
      Seeded BEFORE the key is taken away, which is the deployment this is about:
      it can be holding perfectly good credentials and still have nowhere to keep a
      grant. Removing the key first would only prove the save path refuses.
    */
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);

    let body: unknown = null;
    let status = 0;

    await withoutSecretsKey(async () => {
      const res = await request(app).get(CONNECT).set('Authorization', bearer(systemAdmin));
      status = res.status;
      body = res.body;
    });

    /*
      The 503 arrives BEFORE the URL exists, so no authorization code can be
      requested for a grant this deployment would drop on arrival. The wording is
      the credential-write refusal verbatim: the operator is fixing one thing
      (`SECRETS_KEY`) whichever half of the flow they hit first.
    */
    expect(status).toBe(503);
    expect((body as { error: { code: string; message: string } }).error.code).toBe(
      'SECRETS_NOT_CONFIGURED',
    );
    expect((body as { error: { message: string } }).error.message).toMatch(/SECRETS_KEY/);
    expect((body as { authorizationUrl?: unknown }).authorizationUrl).toBeUndefined();
  });

  it('returns the authorization URL for the CALLER to navigate to', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);

    const res = await request(app).get(CONNECT).set('Authorization', bearer(systemAdmin));

    /*
      NOT A 302, and this assertion exists because the 302 was a bug: the route is
      behind requireAuth, but a browser NAVIGATION to it sends no Authorization
      header, so a redirect from here was unreachable — the button it backed could
      only ever produce "Missing bearer token". Handing the URL back lets the client
      authenticate the call and then navigate.
    */
    expect(res.status).toBe(200);
    const url = new URL(String(res.body.authorizationUrl));
    expect(url.hostname).toBe('appcenter.intuit.com');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('never puts the client SECRET in the URL it hands back', async () => {
    const { app, settingsService } = harness();
    await seedClientCredentials(settingsService);

    const res = await request(app).get(CONNECT).set('Authorization', bearer(systemAdmin));

    // The browser is about to be sent to this URL. The secret authorizes the token
    // exchange server-side and must never appear anywhere the browser can read.
    expect(String(res.body.authorizationUrl)).not.toContain('secret-1');
    expect(JSON.stringify(res.body)).not.toContain('secret-1');
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

  it('denies a forged or absent state BEFORE anything, on the environment path too', async () => {
    /*
      THE ENVIRONMENT PATH IS NOT A WAY AROUND THE STATE CHECK. The whole point of
      resolving credentials from `.env` is that this deployment can complete a
      consent at all — so the callback now has a second, larger blast radius than
      it had, and a forged callback arriving on it must still reach nothing: no
      credential read, no exchange, no write.
    */
    const stub = stubTransport({ access_token: 'a', refresh_token: 'r' });
    const { app, settingsService } = harness({ transport: stub.transport });

    const forged = await request(app).get(`${CALLBACK}?code=attacker&realmId=1&state=forged`);
    const absent = await request(app).get(`${CALLBACK}?code=attacker&realmId=1`);

    expect(stub.calls()).toBe(0);
    expect(locationOf(forged)).toContain('reason=unverified');
    expect(locationOf(absent)).toContain('reason=unverified');
    // Nothing stored, and nothing read: an empty store is still an empty store.
    expect((await settingsService.resolveCredentials()).adaptor).toBeNull();
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

  it('ADOPTS environment credentials into the store on success', async () => {
    /*
      The stored-then-environment rule read the pair from `.env`, so the store held
      only a refresh token whose owning client id was nowhere in it — and the
      deployment stayed one restart away from a token it could not spend. Writing
      what was used is safe HERE and only here: this grant came back from Intuit
      because these exact values were accepted, which is the provenance the
      unattended rotation sink cannot establish.
    */
    const { app, settingsService } = harness({ environment: SANDBOX_ENVIRONMENT });
    await chooseQuickbooksOnly(settingsService);
    const state = issueOAuthState('quickbooks', 'n');

    const res = await request(app).get(
      `${CALLBACK}?code=code-1&realmId=9341457936805547&state=${state}`,
    );

    expect(locationOf(res)).toContain('connect=connected');
    const stored = await settingsService.resolveCredentials();
    expect(stored.adaptor?.fields['refreshToken']).toBe('refresh-1');
    expect(stored.adaptor?.fields['clientId']).toBe('env-client-id');
    expect(stored.adaptor?.fields['clientSecret']).toBe('env-client-secret');
    expect(stored.adaptor?.realmId).toBe('9341457936805547');
    /*
      `baseUrl` travels with them. Left behind, the environment's
      QUICKBOOKS_BASE_URL keeps shadowing whatever is stored, and an operator who
      consented against production from a sandbox-configured deployment is
      authenticated and then 401 on every call with nothing naming the cause. The
      consequence is deliberate: after this, the Intuit environment is changed IN
      THE CONSOLE, not in `.env`.
    */
    expect(stored.adaptor?.baseUrl).toBe('https://sandbox-quickbooks.api.intuit.com');
  });

  it('gives the adopted credentials an OWNER, so they are the ones that get used', async () => {
    /*
      THE GAP THIS EXISTS FOR, and it is the one the adoption test above cannot
      see because it seeds a stored `adaptorId`.

      A credential blob with no owner is unreadable BY DESIGN: both
      `resolveAppCredentials()` and `credentials.provider.ts` gate the stored side
      on the row recording whose credentials they are. So a deployment configured
      entirely from `.env` — which reaches this callback without ever choosing a
      system in the console — completed consent at Intuit, stored the refresh
      token, and then carried on using `QUICKBOOKS_REFRESH_TOKEN`, because nothing
      could read what it had just saved.

      So the assertion is the EFFECT, not the column: after the callback the
      resolver must return the pair the grant was actually made with, out of the
      STORE. If the write is unattributed this fails, and reading the row alone
      would not have caught it.
    */
    const { app, settingsService } = harness({ environment: SANDBOX_ENVIRONMENT });
    const state = issueOAuthState('quickbooks', 'n');

    const res = await request(app).get(
      `${CALLBACK}?code=code-1&realmId=9341457936805547&state=${state}`,
    );

    expect(locationOf(res)).toContain('connect=connected');
    // Recorded as an integration with QuickBooks, even though nobody picked it.
    expect((await settingsService.getSettings()).adaptor.id).toBe('quickbooks');
    // …and the stored half is now the one that answers, not the environment.
    const resolved = await settingsService.resolveAppCredentials();
    expect(resolved?.clientId).toBe('env-client-id');
    expect((await settingsService.resolveCredentials()).adaptor?.fields['refreshToken']).toBe(
      'refresh-1',
    );
    expect(env.QUICKBOOKS_REFRESH_TOKEN).toBe('test-qb-refresh-token');
  });

  it('does not claim the connection is verified on the environment path either', async () => {
    const { app, settingsService } = harness({ environment: SANDBOX_ENVIRONMENT });
    await chooseQuickbooksOnly(settingsService);
    const state = issueOAuthState('quickbooks', 'n');

    await request(app).get(`${CALLBACK}?code=code-1&realmId=934145&state=${state}`);

    // Adoption is not verification. A grant exists; nothing has been asked.
    expect((await settingsService.getSettings()).verifiedAt).toBeNull();
  });

  it('denies a deployment that CANNOT store the grant, without spending the code', async () => {
    let location = '';
    let calls = 0;

    await withoutSecretsKey(async () => {
      const stub = stubTransport({ access_token: 'access-1', refresh_token: 'refresh-1' });
      const { app, settingsService } = harness({
        transport: stub.transport,
        environment: SANDBOX_ENVIRONMENT,
      });
      await chooseQuickbooksOnly(settingsService);
      const state = issueOAuthState('quickbooks', 'n');

      const res = await request(app).get(`${CALLBACK}?code=code-1&realmId=934145&state=${state}`);
      location = locationOf(res);
      calls = stub.calls();

      /*
        Without the gate this deployment completes consent at Intuit, the code is
        spent, and the refresh token is then refused by the store — and the operator
        is told "QuickBooks rejected the authorization" about a grant Intuit
        accepted. Zero exchange calls is the whole assertion.
      */
      expect((await settingsService.resolveCredentials()).adaptor?.fields).toBeUndefined();
    });

    expect(location).toContain('reason=not_writable');
    expect(location).not.toContain('reason=exchange_failed');
    expect(calls).toBe(0);
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
