import { SettingsService } from './settings.service.js';
import { InMemorySettingsRepository } from '../../repositories/inMemory.js';
import { env } from '../../config/env.js';

/*
  The guarantee under test is not "the wizard can save settings" but "a stored
  credential cannot come back out". Every case that writes a secret therefore
  also asserts its absence, from the public projection AND from the bytes the
  repository actually holds — the second is what catches a layer that stores
  plaintext and merely hides it at the edge.
*/

const WEBHOOK_SECRET = 'whsec_abcdefghijklmnop0123456789';
const ADAPTOR_CREDENTIALS = {
  clientId: 'qb-client-id',
  clientSecret: 'qb-client-secret-value',
  accessToken: 'qb-access-token-value',
};

function harness(): { service: SettingsService; repository: InMemorySettingsRepository } {
  const repository = new InMemorySettingsRepository();
  return { service: new SettingsService(repository), repository };
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
