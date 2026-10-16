import { credentialsForAdaptor, connectAdaptor } from './credentials.provider.js';
import { settingsService } from '../settings/settings.service.js';
import { getRepositories } from '../../repositories/index.js';
import { env } from '../../config/env.js';
import type { AccountingAdaptor } from '../../types/adaptor.js';

/*
  THIS FILE CLOSES A DOCUMENTED GAP. Phase 3 left one behind rather than pretending
  otherwise: `credentials.provider.ts` resolves through the `settingsService`
  singleton, so its STORED branch could not be tested until a settings write API
  existed to seed a row. Everything before this exercised the environment fallback
  — which meant the half of the precedence rule that survives the transition,
  "stored wins", was the untested half.

  The environment is not empty in this suite (`setup-env.cjs` sets real-looking
  QuickBooks and Sage values), which is what makes these assertions meaningful:
  preferring a stored value only proves precedence if there was something to
  prefer it over.
*/

function fakeAdaptor(overrides: Partial<AccountingAdaptor> = {}): AccountingAdaptor {
  return {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockResolvedValue('connected'),
    pushCompletedPayment: jest.fn(),
    pullSyncStatus: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    ...overrides,
  };
}

beforeEach(async () => {
  // The settings row lives in the shared in-memory repository, so each case starts
  // from "nothing configured" rather than from whatever the previous one stored.
  await settingsService.updateAdaptor({ id: null, credentials: null, realmId: null, baseUrl: null });
});

describe('credentialsForAdaptor — stored first, environment second', () => {
  it('falls back to the environment when nothing is stored', async () => {
    const credentials = await credentialsForAdaptor('quickbooks');

    expect(credentials.clientId).toBe(env.QUICKBOOKS_CLIENT_ID);
    expect(credentials.clientSecret).toBe(env.QUICKBOOKS_CLIENT_SECRET);
    // The transitional half, and it is load-bearing: deleting it before the wizard
    // can set every field would break every existing install on upgrade. The
    // precondition is that nothing is stored, because a stored grant suppresses
    // the pasted token instead — see the block at the end of this file.
    expect(credentials.accessToken).toBe(env.QUICKBOOKS_ACCESS_TOKEN);
  });

  it('prefers a stored credential over the environment', async () => {
    await settingsService.updateAdaptor({
      id: 'quickbooks',
      credentials: { clientId: 'stored-client-id', clientSecret: 'stored-client-secret' },
    });

    const credentials = await credentialsForAdaptor('quickbooks');

    expect(credentials.clientId).toBe('stored-client-id');
    expect(credentials.clientSecret).toBe('stored-client-secret');
  });

  it('merges per field, so a stored set does not have to be complete to be useful', async () => {
    await settingsService.updateAdaptor({
      id: 'quickbooks',
      credentials: { clientId: 'stored-client-id' },
    });

    const credentials = await credentialsForAdaptor('quickbooks');

    // The wizard may collect a client id before a secret exists. Refusing to
    // connect until every field is stored would make the wizard's own verify step
    // unreachable, which is the step that explains WHICH field is missing.
    expect(credentials.clientId).toBe('stored-client-id');
    expect(credentials.clientSecret).toBe(env.QUICKBOOKS_CLIENT_SECRET);
    // Still a no-stored-GRANT case: a stored client id is not a browser grant, so
    // the pasted environment token is the whole answer here. Storing a refresh
    // token is what would suppress it, and nothing above did.
    expect(credentials.accessToken).toBe(env.QUICKBOOKS_ACCESS_TOKEN);
  });

  it('does not supply one system with the other system’s credentials', async () => {
    await settingsService.updateAdaptor({
      id: 'sage',
      credentials: { clientId: 'stored-sage-client-id', clientSecret: 'stored-sage-secret' },
    });

    const credentials = await credentialsForAdaptor('quickbooks');

    // Credentials are scoped to the system they were entered for. Handing Sage's to
    // QuickBooks would be an authentication attempt nobody asked for.
    expect(credentials.clientId).toBe(env.QUICKBOOKS_CLIENT_ID);
    expect(credentials.clientId).not.toBe('stored-sage-client-id');
  });

  it('rotates to the environment rather than crashing when a stored row cannot be decrypted', async () => {
    // A row sealed under a key this process does not have — the state a botched key
    // rotation leaves behind. `resolveCredentials` cannot open it.
    await getRepositories().settings.update({
      adaptorCredentials: Buffer.from('not-a-sealed-envelope'),
    });

    const credentials = await credentialsForAdaptor('quickbooks');

    // The probe must not crash on it, and the environment is still a valid source;
    // the unreadable row is reported separately by the settings read, which is where
    // an operator can see and act on it.
    expect(credentials.clientId).toBe(env.QUICKBOOKS_CLIENT_ID);
  });
});

/*
  A COMPLETED GRANT SUPERSEDES A PASTED TOKEN.

  `oauth.ts` returns `accessToken` as-is when there is one, so the merged set
  decides the grant actually in use — and the browser callback stores a refresh
  token and deliberately no access token. Without the guard in
  `credentialsForAdaptor`, an operator who re-authorized would be shown
  "connected" while the deployment kept authenticating with the token pasted into
  `.env` before they did, and the deployment would break only once Intuit expired
  that paste: a green tick over a grant that was never exercised.
*/
describe('credentialsForAdaptor — a stored grant outranks a pasted access token', () => {
  it('drops the environment access token and keeps the stored refresh token', async () => {
    await settingsService.updateAdaptor({
      id: 'quickbooks',
      credentials: { clientId: 'stored-client-id', refreshToken: 'stored-refresh-token' },
    });

    const credentials = await credentialsForAdaptor('quickbooks');

    // The grant is the one that ROTATES: `oauth.ts` exchanges this refresh token
    // and `persistRotation` writes the replacement back, which is exactly what a
    // pasted access token can never do.
    expect(credentials.accessToken).toBeUndefined();
    expect(credentials.refreshToken).toBe('stored-refresh-token');
  });

  it('keeps a stored access token, because that is not the pasted one', async () => {
    await settingsService.updateAdaptor({
      id: 'quickbooks',
      credentials: {
        clientId: 'stored-client-id',
        refreshToken: 'stored-refresh-token',
        accessToken: 'stored-access-token',
      },
    });

    const credentials = await credentialsForAdaptor('quickbooks');

    // The guard suppresses the ENVIRONMENT token only. A deployment that stored
    // its own means what it said, and dropping this would leave `oauth.ts` making
    // an exchange it did not need to make.
    expect(credentials.accessToken).toBe('stored-access-token');
    expect(credentials.refreshToken).toBe('stored-refresh-token');
  });

  it('lets both environment tokens through when the stored set carries no grant', async () => {
    await settingsService.updateAdaptor({
      id: 'quickbooks',
      credentials: { clientId: 'stored-client-id', clientSecret: 'stored-client-secret' },
    });

    const credentials = await credentialsForAdaptor('quickbooks');

    // The transitional deployment: an operator's own client id and secret, and
    // tokens only in `.env`. Suppressing them here is what would break every
    // existing install on upgrade.
    expect(credentials.accessToken).toBe(env.QUICKBOOKS_ACCESS_TOKEN);
    expect(credentials.refreshToken).toBe(env.QUICKBOOKS_REFRESH_TOKEN);
  });

  it('treats a whitespace-only stored refresh token as no grant at all', async () => {
    /*
      `updateAdaptor` trims and refuses blanks, so this state is only reachable
      through a credential set written whole — which is exactly when it matters:
      taking `'   '` for a grant would suppress a working pasted token AND leave
      `oauth.ts` exchanging padding, so the deployment would be left with nothing.
    */
    await settingsService.updateAdaptor({ id: 'quickbooks' });
    await settingsService.storeRotatedCredentials({
      clientId: 'stored-client-id',
      refreshToken: '   ',
    });

    const credentials = await credentialsForAdaptor('quickbooks');

    expect(credentials.accessToken).toBe(env.QUICKBOOKS_ACCESS_TOKEN);
  });
});

describe('connectAdaptor — persisting what the upstream rotated', () => {
  it('writes a rotated refresh token back to the settings row', async () => {
    await settingsService.updateAdaptor({
      id: 'quickbooks',
      credentials: { clientId: 'stored-client-id', refreshToken: 'first-refresh-token' },
    });
    const adaptor = fakeAdaptor({
      connect: jest.fn().mockResolvedValue({ rotated: { refreshToken: 'rotated-token' } }),
    });

    await connectAdaptor(adaptor);

    // Intuit invalidates a refresh token as it spends it, so dropping the
    // replacement kills the connection on the next restart — one token lifetime
    // after a screen that said "healthy" (R5).
    const stored = await settingsService.resolveCredentials();
    expect(stored.adaptor?.fields.refreshToken).toBe('rotated-token');
    // …and the rest of the credential set is untouched.
    expect(stored.adaptor?.fields.clientId).toBe('stored-client-id');
  });

  it('does NOT invent a stored credential set from an environment fallback', async () => {
    const adaptor = fakeAdaptor({
      connect: jest.fn().mockResolvedValue({ rotated: { refreshToken: 'rotated-token' } }),
    });

    await connectAdaptor(adaptor);

    /*
      With nothing stored, the credentials came from the environment. Writing the
      rotation into the store would create a credential set that no operator
      entered, and no later reader could tell which of the two sources was
      authoritative — so the rotation is logged as unpersistable instead.
    */
    const stored = await settingsService.resolveCredentials();
    expect(stored.adaptor).toBeNull();
  });
});
