import jwt from 'jsonwebtoken';
import {
  OAUTH_STATE_PURPOSE,
  issueOAuthState,
  verifyOAuthState,
} from './oauthState.js';
import { env } from '../config/env.js';

/*
  The state parameter is the ONLY thing standing between Intuit's browser redirect
  and a forged one, because the callback arrives with no bearer token. These cases
  are therefore about what an ATTACKER can do, not about whether the happy path
  works — the happy path is one assertion and proves nothing.
*/

const GENERIC = 'The connection could not be verified. Start again from the setup page.';

describe('issueOAuthState / verifyOAuthState', () => {
  it('round-trips a well-formed state', () => {
    const state = issueOAuthState('quickbooks', 'nonce-1');

    const payload = verifyOAuthState(state, 'quickbooks');

    expect(payload).toEqual({
      purpose: OAUTH_STATE_PURPOSE,
      adaptor: 'quickbooks',
      nonce: 'nonce-1',
    });
  });

  it('refuses a state whose signature was forged', () => {
    // The attack: build a state by hand claiming a valid flow, so the callback
    // exchanges a code and writes tokens for a company the attacker chose.
    const forged = jwt.sign(
      { purpose: OAUTH_STATE_PURPOSE, adaptor: 'quickbooks', nonce: 'attacker' },
      'not-the-deployment-secret',
      { expiresIn: 600 },
    );

    expect(() => verifyOAuthState(forged, 'quickbooks')).toThrow(GENERIC);
  });

  it('refuses a state minted under a DIFFERENT deployment secret', () => {
    // Cross-deployment isolation. Every deployment has its own JWT_SECRET, so a
    // state harvested from deployment A must not be redeemable at deployment B —
    // otherwise a state is a universal forgery key rather than a per-deployment one.
    // (The real-world cost: rotating JWT_SECRET invalidates in-flight connect
    // attempts, which is acceptable and is the safe direction to fail.)
    const foreign = jwt.sign(
      { purpose: OAUTH_STATE_PURPOSE, adaptor: 'quickbooks', nonce: 'n' },
      'a-different-deployments-secret',
      { expiresIn: 600 },
    );

    expect(() => verifyOAuthState(foreign, 'quickbooks')).toThrow(GENERIC);
  });

  it('refuses an EXPIRED state', () => {
    // Signed already-expired rather than minted with a tiny TTL: the duration parser
    // works in whole seconds, so a sub-second TTL is not a thing it can express.
    const expired = jwt.sign(
      { purpose: OAUTH_STATE_PURPOSE, adaptor: 'quickbooks', nonce: 'nonce-1' },
      env.JWT_SECRET,
      { expiresIn: -60 },
    );

    expect(() => verifyOAuthState(expired, 'quickbooks')).toThrow(GENERIC);
  });

  it('issues a state that is valid immediately, so the normal path is not accidentally expired', () => {
    const state = issueOAuthState('quickbooks', 'nonce-1');

    expect(verifyOAuthState(state, 'quickbooks').nonce).toBe('nonce-1');
  });

  it('refuses a state minted for a different accounting system', () => {
    // Why the adaptor claim exists: a flow started while QuickBooks was selected
    // must not be able to land in a Sage row, or the deployment ends up pointed at
    // a system whose credentials were never entered.
    const state = issueOAuthState('quickbooks', 'nonce-1');

    expect(() => verifyOAuthState(state, 'sage')).toThrow(GENERIC);
  });

  it('refuses a state carrying a different purpose', () => {
    // The cross-endpoint guard: a token signed by us for some other purpose must
    // never be redeemable here, or a CSRF defence becomes a shared token.
    const otherPurpose = jwt.sign(
      { purpose: 'some-other-flow', adaptor: 'quickbooks', nonce: 'n' },
      env.JWT_SECRET,
      { expiresIn: 600 },
    );

    expect(() => verifyOAuthState(otherPurpose, 'quickbooks')).toThrow(GENERIC);
  });

  it('refuses a state missing its claims', () => {
    const bare = jwt.sign({ somethingElse: true }, env.JWT_SECRET, { expiresIn: 600 });

    expect(() => verifyOAuthState(bare, 'quickbooks')).toThrow(GENERIC);
  });

  it('refuses rubbish without throwing anything other than the generic refusal', () => {
    // The same message for every failure: distinct messages tell an attacker which
    // part of a forgery was right.
    for (const bad of ['', 'not.a.jwt', 'a.b.c']) {
      let message = '';
      try {
        verifyOAuthState(bad, 'quickbooks');
      } catch (err) {
        message = err instanceof Error ? err.message : '';
      }
      expect(message).toBe(GENERIC);
    }
  });
});
