import { SettingsService } from './settings.service.js';
import { InMemorySettingsRepository } from '../../repositories/inMemory.js';
import { env } from '../../config/env.js';
import type { AppCredentialEnv } from '../adaptors/appCredentials.js';

/*
  The guarantee under test is not "the wizard can save settings" but "a stored
  credential cannot come back out". Every case that writes a secret therefore
  also asserts its absence, from the public projection AND from the bytes the
  repository actually holds — the second is what catches a layer that stores
  plaintext and merely hides it at the edge.

  THE AUTHORIZATION CASES PASS THEIR OWN ENVIRONMENT. `setup-env.cjs` fills
  `QUICKBOOKS_*` for every suite and `env` is parsed once at import, so a test
  cannot arrange "configured entirely from .env" or "configured entirely from the
  database" by editing `process.env` — the injected environment is the only way to
  tell the two halves of the stored-then-environment rule apart.
*/

const WEBHOOK_SECRET = 'whsec_abcdefghijklmnop0123456789';
const ADAPTOR_CREDENTIALS = {
  clientId: 'qb-client-id',
  clientSecret: 'qb-client-secret-value',
  accessToken: 'qb-access-token-value',
};

/** A deployment whose QuickBooks pair exists only in `.env`. */
const ENV_ONLY: AppCredentialEnv = {
  QUICKBOOKS_CLIENT_ID: 'env-qb-client-id',
  QUICKBOOKS_CLIENT_SECRET: 'env-qb-client-secret',
};

/** A deployment whose `.env` names no application credentials at all. */
const STORE_ONLY: AppCredentialEnv = {};

function harness(
  environment: AppCredentialEnv = env,
): { service: SettingsService; repository: InMemorySettingsRepository } {
  const repository = new InMemorySettingsRepository();
  return { service: new SettingsService(repository, environment), repository };
}

describe('SettingsService — read projection', () => {
  it('reports an unconfigured deployment honestly', async () => {
    const { service } = harness();
    const settings = await service.getSettings();

    expect(settings.configured).toBe(false);
    expect(settings.writable).toBe(true);
    expect(settings.organizationName).toBeNull();
    expect(settings.gateway.webhookSecret).toEqual({
      configured: false,
      lastFour: null,
      unreadable: false,
    });
    expect(settings.adaptor.credentials.configured).toBe(false);
    await expect(service.isConfigured()).resolves.toBe(false);
  });

  it('names the deployment organization from config, not from the row', async () => {
    const { service } = harness();
    // Never stored: two copies of an identity are two chances to disagree.
    await expect(service.getSettings()).resolves.toMatchObject({
      organizationId: env.ORGANIZATION_ID,
    });
  });
});

describe('SettingsService — write-only secrets', () => {
  it('reports presence and a suffix, and never the value', async () => {
    const { service } = harness();
    const settings = await service.updateGateway({ webhookSecret: WEBHOOK_SECRET });

    expect(settings.gateway.webhookSecret.configured).toBe(true);
    expect(settings.gateway.webhookSecret.unreadable).toBe(false);
    expect(settings.gateway.webhookSecret.lastFour).toBe(WEBHOOK_SECRET.slice(-4));
    // The projection is what a response is built from.
    expect(JSON.stringify(settings)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(settings)).not.toContain('whsec_');
  });

  it('does not store the plaintext either', async () => {
    const { service, repository } = harness();
    await service.updateGateway({ webhookSecret: WEBHOOK_SECRET });

    // Straight from the repository: whatever a future layer renders, the bytes
    // on disk must not contain the credential.
    const stored = await repository.get();
    expect(stored.gatewayWebhookSecret).not.toBeNull();
    expect(stored.gatewayWebhookSecret?.includes(Buffer.from(WEBHOOK_SECRET))).toBe(false);
  });

  it('leaves an untouched field alone', async () => {
    const { service } = harness();
    await service.updateGateway({ clientId: 'client-1', webhookSecret: WEBHOOK_SECRET });
    const settings = await service.updateGateway({ clientId: 'client-2' });

    expect(settings.gateway.clientId).toBe('client-2');
    // Absent from the patch, so the stored secret survives — this is the case
    // that a form posting only the fields it changed depends on.
    expect(settings.gateway.webhookSecret.configured).toBe(true);
  });

  it('clears a secret only when null is passed explicitly', async () => {
    const { service } = harness();
    await service.updateGateway({ webhookSecret: WEBHOOK_SECRET });
    const settings = await service.updateGateway({ webhookSecret: null });

    expect(settings.gateway.webhookSecret).toEqual({
      configured: false,
      lastFour: null,
      unreadable: false,
    });
  });

  it('reports an unreadable credential as unreadable, not as absent', async () => {
    const { service, repository } = harness();
    // A row that exists but is not a valid envelope — the state after a key is
    // removed, or after a row arrives from another deployment.
    await repository.update({ gatewayWebhookSecret: Buffer.from('not-an-envelope') });

    const settings = await service.getSettings();
    expect(settings.gateway.webhookSecret.configured).toBe(true);
    expect(settings.gateway.webhookSecret.unreadable).toBe(true);
    // Crucially: reported, not thrown. One unreadable credential must not take
    // out the whole settings read.
    expect(settings.gateway.webhookSecret.lastFour).toBeNull();
  });

  it('refuses to store a credential set that would end up empty', async () => {
    const { service } = harness();
    // Still refused, but the message changed when credentials became a MERGE: it no
    // longer just says the input was empty (which it was not — the value was blank),
    // it names the outcome and how to cause it deliberately. A blank field now
    // means "not filled in", so a set of nothing but blanks resolves to nothing.
    await expect(service.updateAdaptor({ credentials: { clientId: '   ' } })).rejects.toThrow(
      /would be left empty; clear them explicitly/,
    );
  });
});

describe('SettingsService — adaptor and verification', () => {
  it('round-trips adaptor credentials through the server-side accessor', async () => {
    const { service } = harness();
    await service.updateAdaptor({
      id: 'quickbooks',
      realmId: '9341457936805547',
      baseUrl: 'https://quickbooks.api.intuit.com',
      credentials: ADAPTOR_CREDENTIALS,
    });

    const resolved = await service.resolveCredentials();
    expect(resolved.adaptor?.id).toBe('quickbooks');
    expect(resolved.adaptor?.realmId).toBe('9341457936805547');
    expect(resolved.adaptor?.fields).toEqual(ADAPTOR_CREDENTIALS);

    // The public projection still says nothing about the values.
    const settings = await service.getSettings();
    expect(JSON.stringify(settings)).not.toContain('qb-access-token-value');
  });

  it('returns no adaptor credentials until an adaptor and credentials both exist', async () => {
    const { service } = harness();
    await service.updateAdaptor({ credentials: ADAPTOR_CREDENTIALS });
    // Credentials without a chosen adaptor are not a usable connection.
    expect((await service.resolveCredentials()).adaptor).toBeNull();
  });

  it('drops a stale verification when a credential changes', async () => {
    const { service } = harness();
    await service.updateAdaptor({ id: 'quickbooks', credentials: ADAPTOR_CREDENTIALS });
    await service.markVerified('2026-09-24T10:00:00.000Z');
    expect((await service.getSettings()).verifiedAt).toBe('2026-09-24T10:00:00.000Z');

    const after = await service.updateAdaptor({ credentials: { accessToken: 'replacement' } });
    // "Verified" would otherwise describe a credential that no longer exists.
    expect(after.verifiedAt).toBeNull();
  });

  it('keeps a verification when an unrelated preference changes', async () => {
    const { service } = harness();
    await service.markVerified('2026-09-24T10:00:00.000Z');
    const after = await service.updatePreferences({ syncInterval: '5m' });
    expect(after.verifiedAt).toBe('2026-09-24T10:00:00.000Z');
  });

  it('validates the sync cadence with the same parser the TTLs use', async () => {
    const { service } = harness();
    await expect(service.updatePreferences({ syncInterval: 'every so often' })).rejects.toThrow(
      /duration/,
    );
    await expect(service.updatePreferences({ syncInterval: '5m' })).resolves.toMatchObject({
      syncInterval: '5m',
    });
  });

  it('marks the deployment configured only when asked', async () => {
    const { service } = harness();
    await service.updateAdaptor({ id: 'quickbooks', credentials: ADAPTOR_CREDENTIALS });
    expect((await service.getSettings()).configured).toBe(false);

    const done = await service.complete('2026-09-24T11:00:00.000Z');
    expect(done.configured).toBe(true);
    await expect(service.isConfigured()).resolves.toBe(true);
  });
});

describe('SettingsService — can the authorization step run', () => {
  it('offers the button to a deployment configured entirely from the environment', async () => {
    // Nothing stored at all: the shape of every install that still runs off `.env`,
    // and the case the stored-only rule got wrong — it was told its credentials
    // were missing, and the one control that would have fixed it was dead.
    const { service } = harness(ENV_ONLY);
    const settings = await service.getSettings();

    expect(settings.adaptor.canAuthorize).toBe(true);
    expect(settings.adaptor.credentials.configured).toBe(false);
    // Reading the environment does not put a value in the response: presence only.
    expect(JSON.stringify(settings)).not.toContain('env-qb-client-secret');
  });

  it('offers the button to a deployment configured entirely from the wizard', async () => {
    const { service } = harness(STORE_ONLY);
    await service.updateAdaptor({ id: 'quickbooks', credentials: ADAPTOR_CREDENTIALS });

    expect((await service.getSettings()).adaptor.canAuthorize).toBe(true);
  });

  it("does not offer the active adaptor the other system's stored pair", async () => {
    const { service } = harness(STORE_ONLY);
    /*
      Sage's client id and secret, stored without a recorded choice, so nothing in
      the row says they belong to the adaptor this deployment is actually using.
      QuickBooks is that adaptor (the environment's choice — the default), and an
      authorization URL built from Sage's pair is a request the provider refuses for
      a reason the browser cannot show.
    */
    await service.updateAdaptor({
      credentials: { clientId: 'sage-client-id', clientSecret: 'sage-client-secret' },
    });

    const settings = await service.getSettings();
    expect(settings.adaptor.canAuthorize).toBe(false);
    // Still REPORTED as stored. An operator has to be able to see that a
    // credential exists, even when it is not this adaptor's to use.
    expect(settings.adaptor.credentials.configured).toBe(true);
  });

  it('falls back to the environment when the stored set cannot be opened', async () => {
    const { service, repository } = harness(ENV_ONLY);
    // A row sealed under a key this process does not have — what a botched key
    // rotation leaves behind. `resolveCredentials()` throws on this one.
    await repository.update({
      adaptorId: 'quickbooks',
      adaptorCredentials: Buffer.from('not-a-sealed-envelope'),
    });

    const settings = await service.getSettings();
    // The environment can still authorize, so withholding the button would report
    // a deployment as less configured than it is.
    expect(settings.adaptor.canAuthorize).toBe(true);
    // …and the unreadable row is still reported as unreadable, not as absent.
    expect(settings.adaptor.credentials.unreadable).toBe(true);
  });

  it('withholds the button on a deployment that cannot keep what comes back', async () => {
    /*
      NO `SECRETS_KEY`. The provider would accept the authorization code, and the
      refresh token it returned would then be refused by `assertStorable()` and
      discarded — so the operator would be told QuickBooks rejected an
      authorization it had in fact accepted. `secretsConfigured()` reads the parsed
      environment, so the state is arranged the way a deployment without a key
      actually is, and restored immediately after.
    */
    const { service } = harness(ENV_ONLY);
    const key = env.SECRETS_KEY;
    env.SECRETS_KEY = undefined;
    try {
      const settings = await service.getSettings();

      expect(settings.writable).toBe(false);
      // Both halves of the old rule hold — the environment does carry the pair —
      // and the button is still withheld, because the flow cannot run to
      // completion. The flag means "this can be finished", not "this can start".
      expect(settings.adaptor.canAuthorize).toBe(false);
    } finally {
      env.SECRETS_KEY = key;
    }
  });
});

describe('SettingsService — the pair the connect flow is handed', () => {
  it('prefers the stored pair and the stored base URL', async () => {
    const { service } = harness(ENV_ONLY);
    await service.updateAdaptor({
      id: 'quickbooks',
      baseUrl: 'https://sandbox-quickbooks.api.intuit.com',
      credentials: ADAPTOR_CREDENTIALS,
    });

    await expect(service.resolveAppCredentials()).resolves.toEqual({
      clientId: ADAPTOR_CREDENTIALS.clientId,
      clientSecret: ADAPTOR_CREDENTIALS.clientSecret,
      baseUrl: 'https://sandbox-quickbooks.api.intuit.com',
    });
  });

  it('answers from the environment rather than throwing on an unopenable row', async () => {
    const { service, repository } = harness(ENV_ONLY);
    await repository.update({
      adaptorId: 'quickbooks',
      adaptorCredentials: Buffer.from('not-a-sealed-envelope'),
    });

    // `resolveCredentials()` would have thrown here and taken the flow down with
    // it, over a row the environment can replace.
    await expect(service.resolveAppCredentials()).resolves.toEqual({
      clientId: ENV_ONLY.QUICKBOOKS_CLIENT_ID,
      clientSecret: ENV_ONLY.QUICKBOOKS_CLIENT_SECRET,
      baseUrl: null,
    });
  });

  it('answers null when neither source has a pair', async () => {
    const { service } = harness(STORE_ONLY);

    await expect(service.resolveAppCredentials()).resolves.toBeNull();
  });
});
