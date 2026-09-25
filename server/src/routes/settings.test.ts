import request from 'supertest';
import { createApp } from '../app.js';
import { SettingsService } from '../services/settings/settings.service.js';
import { InMemorySettingsRepository } from '../repositories/inMemory.js';
import { AdaptorRegistry } from '../services/adaptors/registry.js';
import { AdaptorAuthError } from '../services/adaptors/errors.js';
import { issueAccessToken } from '../utils/tokens.js';
import { getRepositories } from '../repositories/index.js';
import type { PolicyAttribute } from '../types/auth.js';
import type { AccountingAdaptor } from '../types/adaptor.js';

/*
  The settings API is the onboarding wizard's whole server surface, so these tests
  are about the two promises that make it safe to expose:

  1. A credential goes in and never comes back out.
  2. Testing a credential is a QUESTION. It must not record an observation, because
     the console's probe path files lifecycle events and raises findings — an
     operator making one typo while being helpful would raise a critical finding
     about a value that is about to be corrected, in a list nobody can tell apart
     from a real outage.
*/

const systemAdmin: PolicyAttribute[] = [
  { scope: 'system', organizationId: 'org-1', actions: ['admin'] },
];
const systemWriter: PolicyAttribute[] = [
  { scope: 'system', organizationId: 'org-1', actions: ['write'] },
];
const systemReader: PolicyAttribute[] = [
  { scope: 'system', organizationId: 'org-1', actions: ['read'] },
];
/** Administers system configuration — for a DIFFERENT organization. */
const foreignSystemAdmin: PolicyAttribute[] = [
  { scope: 'system', organizationId: 'other-org', actions: ['admin'] },
];
const operator: PolicyAttribute[] = [
  { scope: 'dashboard', organizationId: 'org-1', actions: ['read', 'ack'] },
];

function bearer(policy: PolicyAttribute[]): string {
  return `Bearer ${issueAccessToken({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@example.com',
    policyAttributes: policy,
  })}`;
}

function fakeAdaptor(overrides: Partial<AccountingAdaptor> = {}): AccountingAdaptor {
  return {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockResolvedValue('connected'),
    pushCompletedPayment: jest.fn(),
    pullSyncStatus: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue({ ok: true, latencyMs: 12 }),
    ...overrides,
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  settingsService: SettingsService;
  repository: InMemorySettingsRepository;
  registry: AdaptorRegistry;
  /** How many instances the registry has built, so `createAdaptor` is provable. */
  built: () => number;
}

function harness(adaptor: AccountingAdaptor = fakeAdaptor()): Harness {
  const repository = new InMemorySettingsRepository();
  const settingsService = new SettingsService(repository);
  const registry = new AdaptorRegistry();
  let constructions = 0;
  registry.register('quickbooks', () => {
    constructions += 1;
    return adaptor;
  });
  registry.register('sage', () => {
    constructions += 1;
    return fakeAdaptor({ id: 'sage', name: 'Sage Accounting' });
  });
  const app = createApp({ settings: { settingsService, adaptorRegistry: registry } });
  return { app, settingsService, repository, registry, built: () => constructions };
}

/** The empty state of both record-keeping services, for the "records nothing" checks. */
async function recordedCounts(): Promise<{ events: number; failures: number }> {
  const repositories = getRepositories();
  return {
    events: (await repositories.events.list(['org-1'])).length,
    failures: (await repositories.failures.list(['org-1'])).length,
  };
}

describe('GET /settings authorization', () => {
  it('refuses an unauthenticated caller', async () => {
    const { app } = harness();

    const res = await request(app).get('/api/v1/settings');

    expect(res.status).toBe(401);
  });

  it('refuses a caller with no system scope, however broad their other access', async () => {
    const { app } = harness();

    const res = await request(app).get('/api/v1/settings').set('Authorization', bearer(operator));

    expect(res.status).toBe(403);
  });

  it('refuses a system administrator of a DIFFERENT organization', async () => {
    const { app } = harness();

    const res = await request(app)
      .get('/api/v1/settings')
      .set('Authorization', bearer(foreignSystemAdmin));

    // There is one deployment and therefore one organization, so authority over
    // another one grants nothing here and there is no parameter to tamper with.
    expect(res.status).toBe(403);
  });

  it('allows a READ-ONLY system holder to read, so a locked page is not an empty one', async () => {
    const { app } = harness();

    const res = await request(app).get('/api/v1/settings').set('Authorization', bearer(systemReader));

    expect(res.status).toBe(200);
    expect(res.body.settings.organizationId).toBe('org-1');
  });

  it('does not let a read-only holder write', async () => {
    const { app } = harness();

    const res = await request(app)
      .put('/api/v1/settings/gateway')
      .set('Authorization', bearer(systemReader))
      .send({ clientId: 'cid' });

    expect(res.status).toBe(403);
  });
});

describe('credentials go in and never come back out', () => {
  it('reports presence and last four, and never the value', async () => {
    const { app } = harness();
    const secret = 'whsec_9f2c41ab77dd4e10';

    const put = await request(app)
      .put('/api/v1/settings/gateway')
      .set('Authorization', bearer(systemAdmin))
      .send({ clientId: 'client-abc', webhookSecret: secret });
    expect(put.status).toBe(200);

    const get = await request(app)
      .get('/api/v1/settings')
      .set('Authorization', bearer(systemAdmin));

    expect(get.body.settings.gateway.clientId).toBe('client-abc');
    expect(get.body.settings.gateway.webhookSecret).toEqual({
      configured: true,
      lastFour: secret.slice(-4),
      unreadable: false,
    });
    // The whole response, not one field: a projection that leaks the value has to
    // fail this, wherever in the shape it appears.
    expect(JSON.stringify(get.body)).not.toContain(secret);
    expect(JSON.stringify(put.body)).not.toContain(secret);
  });

  it('stores the secret sealed, not as readable text', async () => {
    const { app, repository } = harness();
    const secret = 'whsec_9f2c41ab77dd4e10';

    await request(app)
      .put('/api/v1/settings/gateway')
      .set('Authorization', bearer(systemAdmin))
      .send({ webhookSecret: secret });

    const row = await repository.get();
    expect(row.gatewayWebhookSecret).toBeInstanceOf(Buffer);
    // The ciphertext must not CONTAIN the plaintext. `includes` is the assertion
    // that matters: a "sealed" value that is really base64 or a plain Buffer
    // passes an instanceof check and fails this one.
    expect(row.gatewayWebhookSecret?.includes(Buffer.from(secret, 'utf8'))).toBe(false);
  });

  it('rejects a misspelled field instead of silently saving nothing', async () => {
    const { app } = harness();

    const res = await request(app)
      .put('/api/v1/settings/gateway')
      .set('Authorization', bearer(systemAdmin))
      .send({ secret: 'whsec_oops' });

    // Unknown keys are stripped by default, which would answer "saved" to a
    // request that changed nothing — worse than an error, because the operator
    // then leaves.
    expect(res.status).toBe(400);
  });
});

describe('the chosen accounting system', () => {
  it('records the choice, restricts the registry to it, and builds the chosen system fresh', async () => {
    const { app, registry } = harness();
    /*
      An instance built before the choice was made. It carries the credentials it
      connected with — and for QuickBooks a rotated refresh token — so it must not
      go on serving once this write lands.

      Note WHICH instance is discarded: the newly chosen one. The departing
      system's instance is deliberately left alone, because it is unreachable while
      inactive (every consumer filters on `isActive`) and it is reset at the moment
      it is chosen again.
    */
    const staleSage = registry.get('sage');

    const res = await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemWriter))
      .send({ id: 'sage' });

    expect(res.status).toBe(200);
    expect(res.body.settings.adaptor.id).toBe('sage');
    // The choice takes effect in the RUNNING process, not at the next restart.
    expect(registry.isActive('sage')).toBe(true);
    expect(registry.isActive('quickbooks')).toBe(false);
    expect(registry.get('sage')).not.toBe(staleSage);
  });

  it('accepts a write from an administrator who holds only `admin`', async () => {
    const { app } = harness();

    const res = await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ id: 'quickbooks' });

    // The console identifies such an operator with SYSTEM_MANAGE (write OR admin).
    // Gating on `write` alone would refuse someone the console had just invited.
    expect(res.status).toBe(200);
  });
});

describe('POST /settings/adaptor/verify', () => {
  it('records NO lifecycle event and NO finding when the credentials are wrong', async () => {
    const adaptor = fakeAdaptor({
      connect: jest.fn().mockRejectedValue(new AdaptorAuthError('QuickBooks rejected these credentials')),
    });
    const { app } = harness(adaptor);
    const before = await recordedCounts();

    const res = await request(app)
      .post('/api/v1/settings/adaptor/verify')
      .set('Authorization', bearer(systemAdmin))
      .send({ id: 'quickbooks', credentials: { clientId: 'cid', clientSecret: 'wrong' } });

    expect(res.status).toBe(200);
    expect(res.body.verification.ok).toBe(false);
    expect(res.body.verification.reason).toBe('auth');
    expect(res.body.verification.message).toContain('rejected');
    // The point of the whole file: a typo being corrected must not look like an
    // outage. Routing this through `probeAdaptors` would file an
    // `adaptor-auth-failed` event and raise a critical finding.
    expect(await recordedCounts()).toEqual(before);
  });

  it('persists nothing when it tests credentials that were SUPPLIED', async () => {
    const { app, settingsService } = harness();

    const res = await request(app)
      .post('/api/v1/settings/adaptor/verify')
      .set('Authorization', bearer(systemAdmin))
      .send({ id: 'quickbooks', credentials: { clientId: 'cid', clientSecret: 'good' } });

    expect(res.body.verification.ok).toBe(true);
    const settings = await settingsService.getSettings();
    // The wizard asks "would this work?" before saving. Recording the answer would
    // mark a value verified that no row holds.
    expect(settings.verifiedAt).toBeNull();
    expect(settings.adaptor.credentials.configured).toBe(false);
  });

  it('never connects through the CACHED instance, so verifying cannot break a working connection', async () => {
    const { app, registry, built } = harness();
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({
        id: 'quickbooks',
        realmId: 'realm-1',
        credentials: { clientId: 'cid', clientSecret: 'csec' },
      });
    const live = registry.get('quickbooks');
    const builtAfterSave = built();

    const res = await request(app)
      .post('/api/v1/settings/adaptor/verify')
      .set('Authorization', bearer(systemAdmin))
      .send({});

    expect(res.body.verification.ok).toBe(true);
    // A second instance was built for the attempt…
    expect(built()).toBe(builtAfterSave + 1);
    // …and the live one is untouched: `get()` was not used, and it was not reset.
    expect(registry.get('quickbooks')).toBe(live);
  });

  it('records the verification when it tested the STORED credentials', async () => {
    const { app, settingsService } = harness();
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({
        id: 'quickbooks',
        realmId: 'realm-1',
        credentials: { clientId: 'cid', clientSecret: 'csec' },
      });

    const res = await request(app)
      .post('/api/v1/settings/adaptor/verify')
      .set('Authorization', bearer(systemAdmin))
      .send({});

    expect(res.body.verification.ok).toBe(true);
    // This one IS a fact about the row: the stored configuration was confirmed.
    expect((await settingsService.getSettings()).verifiedAt).not.toBeNull();
  });

  it('persists a rotated refresh token rather than spending it and dropping it', async () => {
    const adaptor = fakeAdaptor({
      connect: jest.fn().mockResolvedValue({ rotated: { refreshToken: 'rotated-token' } }),
    });
    const { app, settingsService } = harness(adaptor);
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({
        id: 'quickbooks',
        credentials: { clientId: 'cid', clientSecret: 'csec', refreshToken: 'first' },
      });

    await request(app)
      .post('/api/v1/settings/adaptor/verify')
      .set('Authorization', bearer(systemAdmin))
      .send({});

    // Intuit invalidates a refresh token as it spends it. Discarding the
    // replacement would kill the connection on the next restart (R5) — one token
    // lifetime after a screen that said "healthy".
    const resolved = await settingsService.resolveCredentials();
    expect(resolved.adaptor?.fields.refreshToken).toBe('rotated-token');
  });

  it('NEVER returns a rotated credential, not even to the caller that owns it', async () => {
    /*
      Caught late, and by INSPECTION rather than by the suite — which is the point
      of keeping it: the response originally carried the service's whole result,
      including `rotated`. In STORED mode that value was just minted from the sealed
      refresh token, so the endpoint was publishing a stored secret, the one outcome
      this entire surface exists to prevent. The caller has no use for it in either
      mode: the server persists it, and in SUPPLIED mode the caller sent it.
    */
    const adaptor = fakeAdaptor({
      connect: jest.fn().mockResolvedValue({ rotated: { refreshToken: 'rotated-secret-value' } }),
    });
    const { app } = harness(adaptor);
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({
        id: 'quickbooks',
        credentials: { clientId: 'cid', clientSecret: 'csec', refreshToken: 'first' },
      });

    const res = await request(app)
      .post('/api/v1/settings/adaptor/verify')
      .set('Authorization', bearer(systemAdmin))
      .send({});

    expect(res.body.verification.ok).toBe(true);
    expect(res.body.verification).not.toHaveProperty('rotated');
    expect(JSON.stringify(res.body)).not.toContain('rotated-secret-value');
  });

  it('refuses to test the other system against stored credentials', async () => {
    const { app } = harness();
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ id: 'quickbooks', credentials: { clientId: 'cid', clientSecret: 'csec' } });

    const res = await request(app)
      .post('/api/v1/settings/adaptor/verify')
      .set('Authorization', bearer(systemAdmin))
      .send({ id: 'sage' });

    // Testing QuickBooks' credentials against the Sage choice would probably
    // SUCCEED, which is the worst outcome: it would suggest a working connection to
    // a system this deployment does not use.
    expect(res.status).toBe(400);
  });
});

describe('credentials merge, they do not overwrite each other', () => {
  /*
    THE DEFECT THIS PINS. The credential blob was written as a whole-value replace,
    while every console form sends only the fields the operator actually filled in —
    the rest are blank, because a stored secret is write-only and cannot be
    pre-filled. So re-entering the form to change ONE value silently DELETED the
    others, including the client id the operator could not see and so could not
    retype. The write returned 200 and the connection broke afterwards.
  */
  it('preserves stored fields that a partial update did not mention', async () => {
    const { app, settingsService } = harness();
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({
        id: 'quickbooks',
        credentials: { clientId: 'client-one', clientSecret: 'secret-one', refreshToken: 'refresh-one' },
      });

    // What the wizard sends when an operator retypes only one field.
    const res = await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ credentials: { refreshToken: 'refresh-two' } });
    expect(res.status).toBe(200);

    const stored = await settingsService.resolveCredentials();
    expect(stored.adaptor?.fields).toEqual({
      clientId: 'client-one',
      clientSecret: 'secret-one',
      refreshToken: 'refresh-two',
    });
  });

  it('treats a blank string as "not filled in", never as an instruction to erase', async () => {
    const { app, settingsService } = harness();
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ id: 'quickbooks', credentials: { clientId: 'client-one', clientSecret: 'secret-one' } });

    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ credentials: { clientId: '', clientSecret: '   ' } });

    const stored = await settingsService.resolveCredentials();
    // An empty box means the operator did not fill it in. Erasing is possible but
    // must be said explicitly with `null`, because a form that posts blanks for
    // untouched fields must never be able to destroy a working credential.
    expect(stored.adaptor?.fields).toEqual({ clientId: 'client-one', clientSecret: 'secret-one' });
  });

  it('clears exactly one field when that field is explicitly null', async () => {
    const { app, settingsService } = harness();
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({
        id: 'quickbooks',
        credentials: { clientId: 'client-one', clientSecret: 'secret-one', accessToken: 'stale' },
      });

    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ credentials: { accessToken: null } });

    const stored = await settingsService.resolveCredentials();
    expect(stored.adaptor?.fields).toEqual({ clientId: 'client-one', clientSecret: 'secret-one' });
  });

  it('refuses to leave a credential set that is present but empty', async () => {
    const { app, settingsService } = harness();
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ id: 'quickbooks', credentials: { clientId: 'client-one' } });

    const res = await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ credentials: { clientId: null } });

    // `configured: true` with nothing behind it is exactly the ambiguous state the
    // presence model exists to avoid, so it is refused rather than written.
    expect(res.status).toBe(400);
    // …and the stored value is untouched by the failed attempt.
    expect((await settingsService.resolveCredentials()).adaptor?.fields).toEqual({
      clientId: 'client-one',
    });
  });

  it('still allows clearing the whole set explicitly', async () => {
    const { app, settingsService } = harness();
    await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ id: 'quickbooks', credentials: { clientId: 'client-one' } });

    const res = await request(app)
      .put('/api/v1/settings/adaptor')
      .set('Authorization', bearer(systemAdmin))
      .send({ credentials: null });

    expect(res.status).toBe(200);
    expect((await settingsService.resolveCredentials()).adaptor?.fields ?? null).toBeNull();
  });
});

describe('POST /settings/complete', () => {
  it('stamps the first-run flag, and stays put on a second call', async () => {
    const { app, settingsService } = harness();
    expect((await settingsService.getSettings()).configured).toBe(false);

    const first = await request(app)
      .post('/api/v1/settings/complete')
      .set('Authorization', bearer(systemAdmin))
      .send({});
    expect(first.body.settings.configured).toBe(true);

    const second = await request(app)
      .post('/api/v1/settings/complete')
      .set('Authorization', bearer(systemAdmin))
      .send({});

    // Idempotent: a wizard that is reloaded and finished twice must not report a
    // later "configured at" than the deployment actually was.
    expect(second.body.settings.configuredAt).toBe(first.body.settings.configuredAt);
  });
});
