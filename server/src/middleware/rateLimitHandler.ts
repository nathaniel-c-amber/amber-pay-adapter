/* The one way a throttled route answers.
 *
 * ★ IT WAS THREE IDENTICAL FUNCTIONS. `routes/users.ts` and `routes/settings.ts`
 * each declared a private copy, and a third was about to be written for the
 * public status endpoint — so the guarantee that every throttled route on this
 * server answers 429 in the same shape rested on three copies continuing to
 * agree to stay identical.
 *
 * Lives in `middleware/` beside the other cross-cutting Express pieces and
 * imports only `utils/errors.js`, so any router can use it without pulling in
 * anything else.
 *
 * The body comes from `toHttpError` rather than being written out here, so a
 * throttled response cannot drift from the error shape the rest of the API
 * returns. It is deliberately the same function those two routes already had —
 * moving it is not a chance to improve it, because every existing test asserting
 * on a 429 is asserting on this.
 */

import type { RequestHandler } from 'express';
import { TooManyRequestsError, toHttpError } from '../utils/errors.js';

export const rateLimitHandler: RequestHandler = (_req, res) => {
  const { status, body } = toHttpError(new TooManyRequestsError());
  res.status(status).json(body);
};