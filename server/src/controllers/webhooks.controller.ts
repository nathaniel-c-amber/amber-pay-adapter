import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ValidationError } from '../utils/errors.js';
import { joinUrl } from '../utils/url.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { amberPayGateway } from '../services/gateway/amberpay.service.js';
import { webhookProcessor } from '../services/webhooks/webhookProcessor.service.js';
import { PostgresCheckoutIntentStore } from '../repositories/postgres.js';
import { getPool } from '../db/pool.js';
import type { AmberPayGateway } from '../types/gateway.js';
import type { WebhookProcessor } from '../services/webhooks/webhookProcessor.service.js';
import type { CheckoutIntentStore } from '../services/gateway/checkout.service.js';

export interface WebhooksControllerDeps {
  /** Gateway override (tests inject a stub). */
  gateway?: AmberPayGateway;
  /** Processor override (tests inject a stub). */
  processor?: Pick<WebhookProcessor, 'processWebhook'>;
  /**
   * The checkout intents, for the browser redirect below.
   *
   * `findByTransactionId` had NO production caller until now, which is why a
   * store that already existed for exactly this correlation was sitting unused
   * next to the one thing that needs it.
   */
  intents?: Pick<CheckoutIntentStore, 'findByTransactionId'>;
}

export interface WebhooksController {
  /** POST /api/v1/webhooks/amber-pay */
  receiveAmberPayWebhook: RequestHandler;
}

/**
 * Webhook ingestion. Parses the Amber Pay payload and dispatches to the
 * WebhookProcessor in the background — responding 202 immediately so the
 * sender is not blocked (FR-2.2).
 *
 * ★ THE CALLBACK IS FORM-ENCODED, NOT JSON.
 *
 * A live callback (captured 2026-10-16) is POSTed as
 * `application/x-www-form-urlencoded`. This handler only ever tried `JSON.parse`,
 * and the route's `express.raw` only accepted `application/json`, so the parser
 * type-mismatched, called `next()` without reading the body, and `req.body`
 * arrived `undefined` — which fell back to `Buffer.from('')`, and `JSON.parse('')`
 * threw. EVERY GENUINE DELIVERY WAS ANSWERED 400 AND DROPPED: no lifecycle
 * event, no finding, nothing. The gateway's encoding is the one thing about a
 * callback this side does not get to choose.
 *
 * ★ SIGNATURE VERIFICATION IS ADVISORY — IT RECORDS, IT DOES NOT REJECT.
 *
 * The comment this replaces asserted that "Amber Pay sends NONE — no signature,
 * no timestamp", which is the stated reason this route has no enforcement at
 * all. THAT PREMISE IS FALSE. A live callback carries a `Signature` FIELD: what
 * was never observed was a signature HEADER, and a missing header is not the
 * same fact as a missing field. So the field is read, verified against the raw
 * bytes, and the outcome logged — matched at info, mismatched at warn, absent
 * at warn.
 *
 * WHY ENFORCEMENT IS STILL WRONG, which is the whole argument: the observed
 * value is 32 bytes of BASE64, while `verifyWebhookSignature` computes
 * HMAC-SHA256 as lowercase hex against `AMBER_PAY_WEBHOOK_SECRET`. Those two can
 * never agree. But "forged signature" and "a different algorithm" are
 * indistinguishable from out here — this route has nothing that tells them
 * apart — so enforcing the comparison would reject every real callback and
 * re-create the exact silent-drop defect the form fix above just repaired, only
 * with a 401 instead of a 400. Advisory plus logged is the only honest state
 * until Amber supplies the algorithm.
 *
 * WORTH KNOWING BEFORE READING A LOG: the "matched" branch below cannot fire
 * against the gateway as it behaves today. A signature carried INSIDE the body
 * it signs cannot cover its own bytes, so a self-consistent match is not
 * constructible — every delivery that carries a `Signature` will log the
 * mismatch line, and that is expected rather than alarming. The branch stays
 * because it is the correct policy shape the moment the scheme is known: a
 * header-carried signature, or one computed over the unsigned field subset,
 * both agree with `rawBody` and belong on this route.
 *
 * WHAT STILL HOLDS, and held before: `WebhookProcessor.processWebhook` claims
 * each transaction id atomically before doing any work, so a repeat of any id
 * already seen is dropped, and a `collected` event with no customer is refused
 * rather than guessed at. WHAT IS STILL MISSING, and is the control to put back
 * once the scheme is known: correlating the callback's transaction id against a
 * known, unsettled `checkout_intents` row, so a forged event cannot name a
 * transaction this deployment never issued. Recorded rather than silently
 * accepted.
 *
 * ★ THIS IS ALSO THE CUSTOMER'S RETURN FROM CHECKOUT.
 *
 * The gateway was registered with the SAME url as its callback and as its
 * redirect, so a server-to-server POST and a browser POST arrive here looking
 * identical — same body, same encoding, same signature. That is deliberate: the
 * redirect doubles as a manual re-trigger when the callback never arrived, which
 * is worth far more than a tidier url. It also means the person who just paid
 * has been shown a raw `{"status":"accepted"}` and nothing else, which tells a
 * customer nothing about their money.
 *
 * So the RESPONSE branches, and it branches on the only thing that differs: an
 * `Accept` that names HTML is a browser, and is redirected to the status page
 * with the token minted for that checkout. Everything else — the gateway's own
 * callback, a curl probe, a monitoring agent — keeps the 202 JSON exactly as it
 * was. See `isBrowserCaller` for why content negotiation is not used here, and
 * `resolveIntent` for why a failed lookup degrades to that 202 rather than to an
 * error.
 *
 * The raw body (via `express.raw` on the route) is still read rather than
 * re-serialized: the bounded buffer is what `MAX_WEBHOOK_BODY` caps, and the
 * same exact bytes are what the signature is computed over.
 */

/**
 * Flatten a form-encoded body into the plain string map the gateway schema
 * reads.
 *
 * `URLSearchParams` is the decoder and is deliberately NOT hand-rolled: on this
 * wire `+` means SPACE, which is exactly why the live payload's
 * `ResponseMsg=Invalid+transaction` has to read back as `Invalid transaction`.
 *
 * `RequestData` is itself a URL-encoded JSON string and stays a string. It is
 * never parsed here, so no nested blob can be merged into the payload it wraps
 * and slip past the narrow schema in `amberpay.service.ts`.
 *
 * THE REAL BODY CARRIES BOTH `ResponseMsg` AND `ReponseMsg` — the gateway sends
 * a misspelled duplicate of the same value. They are distinct keys and both
 * survive; there is nothing to deduplicate, and no step here assumes keys are
 * unique.
 */
function formToPayload(rawBody: Buffer): Record<string, string> {
  const params = new URLSearchParams(rawBody.toString('utf8'));
  // No `key=value` pair at all means this was not a form body. Without this an
  // empty object would reach the schema and fail there as a MISSING ClientId,
  // which would describe the wrong problem.
  if (params.size === 0) {
    throw new ValidationError('Invalid webhook payload');
  }
  return Object.fromEntries(params);
}

/**
 * Turn the raw request bytes into the payload object the gateway schema reads.
 *
 * JSON is tried first, then the form encoding — the order matters only for
 * readability: neither encoding is a prefix of the other, so the outcome is the
 * same either way. Nothing else is accepted, and no third parser is mounted on
 * this route.
 */
function parseWebhookBody(rawBody: Buffer): unknown {
  const text = rawBody.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return formToPayload(rawBody);
  }
}

/**
 * The gateway's own signature field, when the delivery carried one.
 *
 * Defensive because `payload` is `unknown`: a JSON body can legitimately parse
 * to a number or a string, and neither can carry a signature.
 */
function signatureOn(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>).Signature;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * ★ IS A BROWSER ON THE OTHER END?
 *
 * THE INPUT IS IDENTICAL IN BOTH CASES, which is the whole problem. This one URL
 * is registered with the gateway as its callback AND as its redirect, so a
 * server-to-server POST and a customer's browser POST arrive with the same body,
 * the same content type and the same signature field. There is nothing IN THE
 * PAYLOAD that says which — so the only honest discriminator is what the caller
 * says it can render, and that is the `Accept` header.
 *
 * WHY NOT `req.accepts(['json', 'html'])`. Express answers with the first entry
 * it likes, and a wildcard `Accept` — which curl, a server, and every monitoring
 * probe sends — matches BOTH. Ordering the list to put html first would send
 * every server-to-server callback to a redirect; putting json first would send
 * every real customer to a JSON body. Neither is a tiebreak, so neither is used.
 *
 * The test is the one thing a browser actually promises: that it will render
 * HTML. Parsed by hand rather than with a header library because the only
 * question is whether `text/html` appears among the accepted types, and a
 * comma-split with a `;q=` tail stripped is the whole of what that needs.
 */
function isBrowserCaller(req: Request): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== 'string') return false;
  return accept
    .split(',')
    .some((entry) => entry.split(';')[0]?.trim().toLowerCase() === 'text/html');
}

/** Where a customer is sent once this route has processed their payment. */
function paymentReturnUrl(statusToken: string): string {
  return joinUrl(env.APP_BASE_URL, `#/payment-return?token=${encodeURIComponent(statusToken)}`);
}

/**
 * The customer's status token for a transaction the gateway echoed back.
 *
 * ★ A FAULT HERE IS SWALLOWED, and the delivery still answers 202. The lookup is
 * the only thing added to a path that is otherwise fire-and-forget, and a
 * database blip must not turn a payment the gateway has already confirmed into a
 * 500 that the sender retries forever. `undefined` means "do not redirect" for
 * both cases — an unmatched transaction and an unreadable row — and the caller
 * logs which.
 */
async function resolveIntent(
  intents: Pick<CheckoutIntentStore, 'findByTransactionId'>,
  transactionId: string,
): Promise<string | undefined> {
  try {
    const intent = await intents.findByTransactionId(env.ORGANIZATION_ID, transactionId);
    return intent?.statusToken ?? undefined;
  } catch (err) {
    logger.error(
      { err, webhookId: transactionId },
      'Could not read the checkout intent for a browser callback',
    );
    return undefined;
  }
}

export function createWebhooksController(
  deps: WebhooksControllerDeps = {},
): WebhooksController {
  const gateway = deps.gateway ?? amberPayGateway;
  const processor = deps.processor ?? webhookProcessor;
  const intents = deps.intents ?? new PostgresCheckoutIntentStore(getPool());

  return {
    receiveAmberPayWebhook: asyncHandler(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      // A body in neither encoding, or in one the schema rejects, still raises
      // `ValidationError` here and is answered 400. What is NOT accepted beyond
      // json + urlencoded was not widened by the form fix.
      const payload = parseWebhookBody(rawBody);
      const event = gateway.parseWebhook(payload);

      // Advisory only — see the block above. Checked AFTER the parse so a
      // garbage body cannot be reported as an unsigned delivery.
      const signature = signatureOn(payload);
      if (signature === undefined) {
        logger.warn(
          { webhookId: event.id },
          'Amber Pay webhook arrived with no Signature field — accepted unverified',
        );
      } else if (gateway.verifyWebhookSignature(rawBody, signature)) {
        logger.info({ webhookId: event.id }, 'Amber Pay webhook signature matched');
      } else {
        logger.warn(
          { webhookId: event.id },
          'Amber Pay webhook signature did not match our HMAC-SHA256 — advisory only, delivery accepted',
        );
      }

      // Log the IDENTITY, never the payload. The wire body carries an amount,
      // a customer reference and a card token, and `console.log` bypasses the
      // redaction configured in `utils/logger.ts`.
      logger.info({ webhookId: event.id, webhookType: event.type }, 'Webhook accepted');

      // Defense-in-depth: processWebhook already never throws, but guard the
      // fire-and-forget task so an unexpected rejection can't surface.
      void processor.processWebhook(event).catch((err: unknown) => {
        logger.error({ err }, 'Background webhook processing failed');
      });

      /*
        ★ THE RESPONSE BRANCHES ON THE CALLER, NOT ON THE INPUT.

        Above, the identical body was parsed and dispatched. What happens next is
        the only difference between two callers this route cannot otherwise tell
        apart: the gateway's server-to-server callback gets the 202 JSON it has
        always got, and a customer's browser is redirected to a page that can
        actually tell them what happened to their money.

        THE 202 IS UNCHANGED. That path works, the sender depends on it, and the
        branch below cannot reach it unless `Accept` names HTML.
      */
      if (isBrowserCaller(req)) {
        const intent = await resolveIntent(intents, event.id);
        if (intent === undefined) {
          /*
            NO INTENT, NO REDIRECT. A customer sent to a page about a token we
            never minted would see an empty result with no way to tell it from a
            payment still processing — and the fallback they DO get, the same JSON
            every server-to-server caller gets, at least says plainly that we
            received it. A dead page is worse than an honest one.
          */
          logger.warn(
            { webhookId: event.id },
            'Browser arrived at the webhook callback with no matching checkout intent — answered 202 instead of redirecting',
          );
        } else {
          res.redirect(302, paymentReturnUrl(intent));
          return;
        }
      }

      res.status(202).json({ status: 'accepted' });
    }),
  };
}
