/* The `state` parameter that stands between Intuit's callback and a forged one.
 *
 * WHY THIS EXISTS AT ALL. The QuickBooks authorization-code flow ends with the
 * provider REDIRECTING THE BROWSER to our callback, so the callback cannot require
 * a bearer token — by the time it runs, the request is a plain navigation from
 * Intuit with no credential attached. Without a `state` check, any third party
 * could complete a flow in a victim's browser and have the resulting tokens
 * written into this deployment's settings, or redirect a real operator to a URL
 * that looks like ours.
 *
 * IT IS STATELESS, which is the important design decision. Intuit's callback
 * arrives with no session and no cookie we control reliably (third-party cookie
 * policies make a session cookie a poor foundation), so a server-side store would
 * need cleanup and would leak on crash. Instead the value carries everything the
 * callback needs and is signed with the deployment's existing `JWT_SECRET`.
 *
 * THE `purpose` CLAIM IS NOT PARANOIA. One signed token must not be redeemable at
 * two endpoints: without this, a state minted for "connect the accounting system"
 * would also be accepted by any future endpoint that verifies a state, which is
 * how a CSRF defence becomes a cross-endpoint token. The claim makes the token
 * single-use across purposes.
 *
 * WHAT THIS DOES *NOT* GUARANTEE — stated plainly rather than implied. The
 * signature prevents a third party from *minting* a state. It does not stop a
 * third party from *replaying* one they intercepted within its short life. That
 * residual is bounded by the 10-minute lifetime, and Intuit additionally rejects
 * a reused authorization code, so the practical exposure is a replayed connect
 * attempt rather than a duplicated token.
 */

import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ValidationError } from './errors.js';
import { parseDurationSeconds } from './duration.js';

/**
 * Short, because the state is a bearer-of-nothing hop between two redirects.
 * A person has to log in at Intuit and consent, which takes longer than this
 * comfortably allows for a slow login on a corporate network — but the window is
 * minutes, not hours, because every second of it is replayable.
 */
export const OAUTH_STATE_TTL = '10m';

/** The only purpose a QuickBooks connect state may be redeemed for. */
export const OAUTH_STATE_PURPOSE = 'quickbooks-connect';

const statePayloadSchema = z.object({
  /** Purpose, so this token cannot be spent at another endpoint. */
  purpose: z.literal(OAUTH_STATE_PURPOSE),
  /**
   * Which accounting system the flow was started for. Without it, a state minted
   * while QuickBooks was selected could complete a flow that then wrote Sage's
   * tokens into a QuickBooks row.
   */
  adaptor: z.enum(['quickbooks', 'sage']),
  /** Random per-flow value, so two simultaneous connects are distinguishable. */
  nonce: z.string().min(1),
  exp: z.number().optional(),
});

export interface OAuthStatePayload {
  purpose: typeof OAUTH_STATE_PURPOSE;
  adaptor: 'quickbooks' | 'sage';
  nonce: string;
}

/**
 * Mint a state parameter for one connect attempt.
 *
 * The nonce is supplied by the caller rather than generated here so the caller can
 * keep a stable reference for the lifetime of the request; it is not secret, only
 * unpredictable-by-accident, and the signature is what provides the guarantee.
 */
export function issueOAuthState(
  adaptor: 'quickbooks' | 'sage',
  nonce: string,
  ttl: string = OAUTH_STATE_TTL,
): string {
  const ttlSeconds = parseDurationSeconds(ttl);
  if (ttlSeconds <= 0) {
    throw new ValidationError('OAuth state TTL must be positive');
  }
  return jwt.sign(
    { purpose: OAUTH_STATE_PURPOSE, adaptor, nonce },
    env.JWT_SECRET,
    { expiresIn: ttlSeconds },
  );
}

/**
 * Verify a state parameter and return its claims.
 *
 * EVERY failure mode — bad signature, expiry, wrong purpose, wrong adaptor,
 * malformed shape — raises the SAME `ValidationError` with a generic message. A
 * distinct message per failure tells an attacker which part of the token they got
 * right, which is free reconnaissance for a forgery attempt.
 */
export function verifyOAuthState(
  state: string,
  expectedAdaptor: 'quickbooks' | 'sage',
): OAuthStatePayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(state, env.JWT_SECRET);
  } catch {
    throw new ValidationError('The connection could not be verified. Start again from the setup page.');
  }

  const result = statePayloadSchema.safeParse(decoded);
  if (!result.success || result.data.purpose !== OAUTH_STATE_PURPOSE) {
    throw new ValidationError('The connection could not be verified. Start again from the setup page.');
  }
  if (result.data.adaptor !== expectedAdaptor) {
    // Same generic refusal as above: an operator who somehow lands here has a
    // stale flow, and the remedy is identical — go back and start again.
    throw new ValidationError('The connection could not be verified. Start again from the setup page.');
  }

  return { purpose: result.data.purpose, adaptor: result.data.adaptor, nonce: result.data.nonce };
}
