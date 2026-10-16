import {
  environmentAdaptorCredentials,
  resolveAppCredentials,
  type AppCredentialEnv,
} from './appCredentials.js';

/*
  `config/env.ts` parses `process.env` ONCE, at import, and `setup-env.cjs` fills
  the QuickBooks variables for every suite — so a test cannot set an environment
  value and expect this module to see it. Both functions take the environment as
  an argument for exactly that reason, and the cases below inject their own.

  That is not a testing convenience. It is the same seam the browser
  authorization needs: a merge rule nobody can exercise without a settable
  environment is a merge rule whose "environment fills the gap" half is asserted
  only against whatever the suite happened to boot with.
*/

const environment: AppCredentialEnv = {
  QUICKBOOKS_CLIENT_ID: 'env-qb-client-id',
  QUICKBOOKS_CLIENT_SECRET: 'env-qb-client-secret',
  QUICKBOOKS_BASE_URL: 'https://sandbox-quickbooks.intuit.com',
  QUICKBOOKS_REALM_ID: 'env-qb-realm-id',
  SAGE_CLIENT_ID: 'env-sage-client-id',
  SAGE_CLIENT_SECRET: 'env-sage-client-secret',
  SAGE_BASE_URL: 'https://api.accounting.sage.com',
};

const nothingConfigured: AppCredentialEnv = {};

describe('resolveAppCredentials — stored first, environment second', () => {
  it('prefers the stored value for every field the stored set carries', () => {
    const resolved = resolveAppCredentials(
      'quickbooks',
      { clientId: 'stored-client-id', clientSecret: 'stored-client-secret' },
      environment,
    );

    // Both sources are populated here, which is what makes the assertion mean
    // something: a stored value that wins over an environment value it could
    // have used is a precedence rule, not a coincidence.
    expect(resolved).toEqual({
      clientId: 'stored-client-id',
      clientSecret: 'stored-client-secret',
    });
  });

  it('fills a gap from the environment when the stored set is partial', () => {
    // The wizard collects a client id before a secret exists, and the stored blob
    // is merged rather than replaced (see `mergeCredentials`), so an incomplete
    // stored set is the normal state of a deployment mid-setup rather than an
    // error. Refusing to resolve it would make the wizard's own verify step —
    // the one that names the missing half — unreachable.
    const resolved = resolveAppCredentials('quickbooks', { clientId: 'stored-client-id' }, environment);

    expect(resolved).toEqual({
      clientId: 'stored-client-id',
      clientSecret: 'env-qb-client-secret',
    });
  });

  it('resolves both halves from the environment when nothing is stored', () => {
    // A deployment configured entirely from `.env` is the case the fallback
    // exists for: delete it before the wizard can set every field and every such
    // install is refused a connection it has always had.
    const resolved = resolveAppCredentials('quickbooks', null, environment);

    expect(resolved).toEqual({
      clientId: 'env-qb-client-id',
      clientSecret: 'env-qb-client-secret',
    });
  });

  it('refuses to resolve when either half is blank or whitespace only', () => {
    // Half a client credential is not a weaker version of one: it cannot build an
    // authorization URL, and returning it would let a caller fail at Intuit with
    // an error naming a parameter the operator never supplied. A padded value is
    // blank for the same reason an empty one is — a text input submits both.
    expect(
      resolveAppCredentials('quickbooks', { clientId: '  ', clientSecret: '' }, nothingConfigured),
    ).toBeNull();

    // …and one half resolving is not enough on its own.
    expect(
      resolveAppCredentials('quickbooks', { clientId: '   ', clientSecret: 'stored-secret' }, nothingConfigured),
    ).toBeNull();
  });

  it('ignores the stored side entirely when there is none', () => {
    // `null` and `undefined` are what a deployment that never ran the wizard
    // carries, and they must behave identically — a resolver that treated
    // `undefined` as an empty object would still resolve, but one that indexed
    // into it would throw at the authorization link an operator is waiting on.
    expect(resolveAppCredentials('quickbooks', null, environment)).toEqual({
      clientId: 'env-qb-client-id',
      clientSecret: 'env-qb-client-secret',
    });
    expect(resolveAppCredentials('quickbooks', undefined, environment)).toEqual({
      clientId: 'env-qb-client-id',
      clientSecret: 'env-qb-client-secret',
    });
  });

  it('does not read the other adaptor’s values while resolving this one', () => {
    // The fixture populates both systems on purpose: a resolver that reached for
    // the wrong prefix would still return something, and an authentication
    // attempt against the wrong tenant is not a failure an operator can trace
    // back to this file.
    const resolved = resolveAppCredentials('sage', null, environment);

    expect(resolved).toEqual({
      clientId: 'env-sage-client-id',
      clientSecret: 'env-sage-client-secret',
    });
  });
});

describe('environmentAdaptorCredentials — the moved fallback', () => {
  it('reads the injected environment, not the process one', () => {
    // The injection seam is the thing the merge rule above is testable BECAUSE
    // of: a module that ignored its argument would still pass against the suite's
    // QuickBooks values and fail against an operator's deployment.
    const credentials = environmentAdaptorCredentials('quickbooks', environment);

    expect(credentials.clientId).toBe('env-qb-client-id');
    expect(credentials.clientSecret).toBe('env-qb-client-secret');
    expect(credentials.baseUrl).toBe('https://sandbox-quickbooks.intuit.com');
    expect(credentials.realmId).toBe('env-qb-realm-id');
  });

  it('passes an absent value through as absent', () => {
    // The merge, not this function, decides what is present. Dropping the key
    // here would make an unconfigured field indistinguishable from one this
    // module never looked at, and the settings row writes the difference.
    const credentials = environmentAdaptorCredentials('quickbooks', nothingConfigured);

    expect(credentials.clientId).toBeUndefined();
    expect(credentials.clientSecret).toBeUndefined();
  });
});