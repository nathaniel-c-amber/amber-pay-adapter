import express from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import { createWebhookRouter } from './webhooks.js';
import { errorHandler, notFoundHandler } from '../middleware/errorHandler.js';
import { AmberPayGatewayImpl } from '../services/gateway/amberpay.service.js';
import { isStatusToken } from '../services/gateway/amberPayWire.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { joinUrl } from '../utils/url.js';
import type { WebhookEvent } from '../types/gateway.js';

/**
 * Amber Pay's WIRE payload — deliberately not the pipeline's normalised event.
 * The gateway's own field names and status vocabulary are the contract these
 * tests defend; asserting on the normalised shape here would let a mapping
 * regression pass unnoticed.
 */
const payload = {
  ClientId: 'client-0001',
  TransactionId: 'txn_000000000001',
  OrderId: 'ord_000000000001',
  PaymentStatus: 'Success',
  EventTimestamp: '2026-01-01T00:00:00.000Z',
};

const rawBody = JSON.stringify(payload);

/**
 * The event a delivery was dispatched with.
 *
 * Read through here rather than indexing `mock.calls[0][0]` at each call site,
 * because the index is only meaningful once the call has been asserted — and
 * asserting it at the point of use is what keeps "the processor was never
 * called" from reading as an assertion about `id`.
 */
function dispatched(
  processor: jest.Mock<Promise<void>, [WebhookEvent]>,
): WebhookEvent {
  expect(processor).toHaveBeenCalledTimes(1);
  const event = processor.mock.calls[0]?.[0];
  if (event === undefined) throw new Error('processor was not called');
  return event;
}

describe('webhooks route', () => {
  const app = createApp();

  /*
    NO SIGNATURE IS REQUIRED, and these tests are the record of why.

    The route once refused any delivery whose `x-amber-pay-signature` header was
    missing or wrong. Live traffic then showed Amber Pay sends no such header on
    any callback, so the check rejected every genuine event. Verification was
    removed on purpose; the first test pins that a bare payload is accepted, and
    the second pins that a bogus signature header is ignored rather than
    resurrecting the 401.
  */
  it('returns 202 for a well-formed payload carrying no signature header', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/json')
      .send(rawBody);
    expect(res.status).toBe(202);
  });

  it('returns 202 even when a signature header is present but invalid (it is not consulted)', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/json')
      .set('x-amber-pay-signature', 'not-a-real-signature')
      .send(rawBody);
    expect(res.status).toBe(202);
  });

  it('returns 400 for a body that is not valid JSON', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
  });
});

/*
  VERBATIM from the live gateway, and the test that exists because of it.

  Every fixture above this line was JSON. The gateway does not send JSON: it
  POSTs `application/x-www-form-urlencoded`, which the route's `express.raw`
  did not match — so `req.body` was `undefined`, `JSON.parse('')` threw, and
  EVERY GENUINE CALLBACK WAS ANSWERED 400 AND SILENTLY DROPPED. Every one of
  these fixtures is the real wire encoding so that cannot regress unnoticed.
*/
const REAL_FORM_CALLBACK = [
  'ClientId=quick_book_stage',
  'StoreVerifyFlag=null',
  'TransactionId=E09KUZXK6BZJ',
  'OrderId=17921677369780E09KUZXK6BZJ',
  'PaymentStatus=Failed',
  'Amount=25000',
  'CurrencyCode=JMD',
  'ResponseMsg=Invalid+transaction',
  'ReponseMsg=Invalid+transaction',
  'RequestData=%7B%22ClientId%22%3A%22quick_book_stage%22%2C%22TransactionId%22%3A%22E09KUZXK6BZJ%22%2C%22CurrencyCode%22%3A%22JMD%22%2C%22Amount%22%3A%2225000%22%2C%22Signature%22%3A%22amE5elFFSUNUSDlBRmN1WlJWa09iRTJ4dDlwMjh3cU1leHYvZjkxZlFhYlBjcUNLNCtxNk9pN2E0NC9mQXJOUQ%3D%3D%22%2C%22CustomerReference%22%3A%22STU025%22%2C%22CustomerInvoice%22%3A%22N%22%2C%22ReturnToMerchant%22%3A%22Y%22%2C%22AutoRedirect%22%3A%22Y%22%7D',
  'AutoRedirect=Y',
  'ReturnToMerchant=Y',
  'CustomMessage=null',
  'PaymentMethod=STANDARD',
  'ErrorCode=',
  'ErrorMessage=Invalid+transaction',
  'Signature=amE5elFFSUNUSDlBRmN1WlJWa09iRTJ4dDlwMjh3cU1leHYvZjkxZlFhYlBjcUNLNCtxNk9pN2E0NC9mQXJOUQ==',
].join('&');

describe('webhooks route — the gateway\'s real wire encodings', () => {
  const gateway = new AmberPayGatewayImpl();
  let processWebhook: jest.Mock<Promise<void>, [WebhookEvent]>;
  let app: express.Express;

  beforeEach(() => {
    processWebhook = jest.fn<Promise<void>, [WebhookEvent]>().mockResolvedValue(undefined);
    app = express();
    app.use('/api/v1', createWebhookRouter({ gateway, processor: { processWebhook } }));
    app.use(notFoundHandler);
    app.use(errorHandler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function postForm(body: string) {
    return request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(body);
  }

  function postJson(body: string) {
    return request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/json')
      .send(body);
  }

  it('accepts the REAL form-encoded callback and dispatches it with the right identity', async () => {
    const res = await postForm(REAL_FORM_CALLBACK);

    expect(res.status).toBe(202);
    expect(processWebhook).toHaveBeenCalledTimes(1);
    // The identity is OURS: the gateway echoes `TransactionId`, and `Failed`
    // maps to `payment.failed`. `reference` is null because the real payload
    // carries no StudentID — the customer is simply not named, which is a real
    // state and not a malformed one.
    expect(dispatched(processWebhook)).toMatchObject({
      id: 'E09KUZXK6BZJ',
      type: 'payment.failed',
      status: 'failed',
      reference: null,
    });
  });

  it('decodes the form correctly: `+` is a space, both message keys survive, RequestData stays a string', async () => {
    const parse = jest.spyOn(gateway, 'parseWebhook');
    const verify = jest.spyOn(gateway, 'verifyWebhookSignature');

    const res = await postForm(REAL_FORM_CALLBACK);

    expect(res.status).toBe(202);
    const wire = parse.mock.calls[0]?.[0] as Record<string, string>;
    // `+` means SPACE on this wire. A hand-rolled decoder that splits on `&`
    // and `=` without decoding would read `Invalid+transaction` literally.
    expect(wire.ResponseMsg).toBe('Invalid transaction');
    // The gateway sends a MISSPELLED DUPLICATE of the same field. It is a
    // distinct key, so it survives — there is nothing to deduplicate, and the
    // decoder must not assume keys are unique.
    expect(wire.ReponseMsg).toBe('Invalid transaction');
    // `RequestData` is itself URL-encoded JSON. It stays a STRING: parsing it
    // would merge an amount and a customer reference into the payload the
    // narrow schema is there to strip.
    expect(typeof wire.RequestData).toBe('string');
    expect(() => JSON.parse(wire.RequestData ?? '')).not.toThrow();

    // The gateway hands the RAW BYTES to the verifier, not a re-serialized
    // object — the whole reason the route stays `express.raw`.
    expect(verify).toHaveBeenCalledTimes(1);
    const [raw, signature] = verify.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(raw?.toString('utf8')).toBe(REAL_FORM_CALLBACK);
    expect(signature).toBe('amE5elFFSUNUSDlBRmN1WlJWa09iRTJ4dDlwMjh3cU1leHYvZjkxZlFhYlBjcUNLNCtxNk9pN2E0NC9mQXJOUQ==');
  });

  it('keeps a mismatched signature ADVISORY — logged, never rejected', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    // The live `Signature` is 32 bytes of base64 and our verifier computes
    // HMAC-SHA256 hex, so it cannot match. Enforcing that would drop every real
    // callback, which is the bug this route already had once.
    const res = await postForm(REAL_FORM_CALLBACK);

    expect(res.status).toBe(202);
    expect(processWebhook).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { webhookId: 'E09KUZXK6BZJ' },
      expect.stringContaining('did not match'),
    );
  });

  it('still accepts the JSON encoding (the route is not form-only)', async () => {
    const res = await postJson(JSON.stringify({
      ClientId: 'quick_book_stage',
      TransactionId: 'WKjMPE0MR0u3',
      OrderId: '17906110924250WKjMPE0MR0u3',
      StudentID: 'STU0026',
      PaymentStatus: 'Success',
    }));

    expect(res.status).toBe(202);
    expect(processWebhook).toHaveBeenCalledTimes(1);
    expect(dispatched(processWebhook)).toMatchObject({
      id: 'WKjMPE0MR0u3',
      type: 'payment.collected',
      reference: 'STU0026',
    });
  });

  it('warns that a delivery with no Signature field is unverified, and still accepts it', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const unsigned = REAL_FORM_CALLBACK
      .split('&')
      .filter((pair) => !pair.startsWith('Signature='))
      .join('&');

    const res = await postForm(unsigned);

    expect(res.status).toBe(202);
    expect(processWebhook).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { webhookId: 'E09KUZXK6BZJ' },
      expect.stringContaining('no Signature field'),
    );
  });

  it('returns 400 for a body that is neither JSON nor a form', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    // No `key=value` pair anywhere, so `URLSearchParams` cannot read it and the
    // schema has nothing to accept. The route did not widen what it takes
    // beyond json + urlencoded.
    const res = await postForm('this-body-is-not-a-form');

    expect(res.status).toBe(400);
    expect(processWebhook).not.toHaveBeenCalled();
    // A body that never parsed is not an UNSIGNED delivery, and must not be
    // logged as one — the signature check runs after the parse for that reason.
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('no Signature field'),
    );
  });
});

/*
  ★ THIS IS ALSO THE CUSTOMER'S RETURN FROM CHECKOUT.

  The gateway was registered with the SAME url as its callback and as its
  redirect, so the two arrivals here are byte-identical: same body, same
  encoding, same signature field. "The gateway's own redirect doubles as a manual
  re-trigger when the callback never arrived, which is worth far more than a
  tidier url" — so the branch below cannot change what is parsed and dispatched,
  only what is ANSWERED, and every test here checks both halves.

  `intents` is injected. The controller's default is
  `new PostgresCheckoutIntentStore(getPool())`, which builds a real pool at
  controller-construction time; a browser test that relied on the default would
  be testing against a database it has no business reaching.
*/
describe('webhooks route — the customer\'s return from checkout', () => {
  const gateway = new AmberPayGatewayImpl();

  /**
   * The token this deployment minted for the checkout the gateway just echoed.
   *
   * Base64url, like every token `amberPayWire.ts` mints: no character in it
   * needs percent-encoding to survive a query string and a fragment, which is
   * precisely why the alphabet excludes `+` and `/`.
   */
  const STATUS_TOKEN = 'kQ3vZx1NpJ7cR2wYbT9mL4dH6fG0sA8uE1iO5nP7qRj';

  /** The transaction id inside `REAL_FORM_CALLBACK`, which is the one echoed. */
  const TRANSACTION_ID = 'E09KUZXK6BZJ';

  let processWebhook: jest.Mock<Promise<void>, [WebhookEvent]>;
  let findByTransactionId: jest.Mock<
    Promise<{ studentId: string; statusToken: string | null } | undefined>,
    [string, string]
  >;
  let app: express.Express;

  beforeEach(() => {
    processWebhook = jest.fn<Promise<void>, [WebhookEvent]>().mockResolvedValue(undefined);
    // The happy case: a gateway callback naming an intent this deployment minted
    // a token for. Both every test in this block and every one that changes it
    // starts from here, so each test below reads as the ONE thing it changes.
    findByTransactionId = jest
      .fn<Promise<{ studentId: string; statusToken: string | null } | undefined>, [string, string]>()
      .mockResolvedValue({ studentId: 'STU025', statusToken: STATUS_TOKEN });
    app = express();
    app.use(
      '/api/v1',
      createWebhookRouter({
        gateway,
        processor: { processWebhook },
        intents: { findByTransactionId },
      }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * The customer's browser arriving, which is a POST of the SAME real wire
   * callback — only the `Accept` header tells the two callers apart.
   */
  function postAsBrowser(accept: string) {
    return request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Accept', accept)
      .send(REAL_FORM_CALLBACK);
  }

  it('redirects a browser to the status page for the checkout this delivery names', async () => {
    /*
      "an `Accept` that names HTML is a browser, and is redirected to the status
      page with the token minted for that checkout."

      The header is asserted WHOLE rather than by a substring: this url is
      assembled from a configured base and an encoded token, and a doubled slash
      or a token that lost its encoding would send a customer to a page about a
      token we never minted — the exact failure the missing-intent fallback
      exists to avoid.
    */
    const res = await postAsBrowser('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      joinUrl(env.APP_BASE_URL, `#/payment-return?token=${encodeURIComponent(STATUS_TOKEN)}`),
    );
    // The token in the url IS the stub's value — the one minted with this intent,
    // not the transaction id, not a token derived from the delivery. And it needs
    // no encoding at all, which is the property base64url was chosen for.
    expect(res.headers.location).toContain(STATUS_TOKEN);
    expect(encodeURIComponent(STATUS_TOKEN)).toBe(STATUS_TOKEN);
    // And it is a token the status endpoint will actually resolve: this url is
    // the only address the customer can be given, and a value of the wrong shape
    // in it is a 400 on the page they were sent to read.
    expect(isStatusToken(STATUS_TOKEN)).toBe(true);
  });

  it('looks the intent up under THIS deployment\'s organization, not an id from the body', async () => {
    // The gateway's echoed transaction id is the correlation, but the row is
    // keyed by organization as well — so the lookup has to carry ours. A missing
    // organization here would silently match nothing.
    await postAsBrowser('text/html');

    expect(findByTransactionId).toHaveBeenCalledWith(env.ORGANIZATION_ID, TRANSACTION_ID);
  });

  it('still DISPATCHES the delivery it redirects, because the arrival IS the retry', async () => {
    /*
      ★ THE REASON THIS URL IS REGISTERED TWICE.

      "the redirect doubles as a manual re-trigger when the callback never
      arrived" — so the browser's arrival has to go through `processWebhook` on
      exactly the same path as the server-to-server one. A redirect that returned
      before the dispatch would look identical from the customer's side (they get
      their page either way) while quietly deleting the only manual retry the
      gateway gives us, which is why this asserts the dispatch rather than the
      response.
    */
    const res = await postAsBrowser('text/html');

    expect(res.status).toBe(302);
    expect(dispatched(processWebhook)).toMatchObject({
      id: TRANSACTION_ID,
      type: 'payment.failed',
    });
  });

  it('answers 202 and does NOT redirect a browser we have no intent for', async () => {
    /*
      ★ NO INTENT, NO REDIRECT.

      "A customer sent to a page about a token we never minted would see an empty
      result with no way to tell it from a payment still processing — and the
      fallback they DO get, the same JSON every server-to-server caller gets, at
      least says plainly that we received it. A dead page is worse than an honest
      one."

      So the absence of `Location` is the assertion, not the status code alone:
      a 202 WITH a Location would be a redirect wearing the honest status.
    */
    findByTransactionId.mockResolvedValue(undefined);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    const res = await postAsBrowser('text/html');

    expect(res.status).toBe(202);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toEqual({ status: 'accepted' });
    // Still dispatched: an unmatched intent is a correlation failure, not a
    // reason to drop the delivery on the floor.
    expect(processWebhook).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { webhookId: TRANSACTION_ID },
      expect.stringContaining('no matching checkout intent'),
    );
  });

  it('does not redirect with an intent that has no token (a row that predates them)', async () => {
    /*
      `status_token` is NULLABLE — migration 009 is explicit that every intent
      already in the table predates the column, and "a missing token is a true
      statement". So `findByTransactionId` can return an intent with no token,
      and that must degrade the same way an unmatched transaction does: a url
      reading `token=null` would be a page about a handle that never existed.
    */
    findByTransactionId.mockResolvedValue({ studentId: 'STU025', statusToken: null });

    const res = await postAsBrowser('text/html');

    expect(res.status).toBe(202);
    expect(res.headers.location).toBeUndefined();
  });

  it('answers 202 when the intent lookup FAILS — a database blip is not a retry-forever 500', async () => {
    /*
      ★ A FAULT HERE IS SWALLOWED, and the delivery still answers 202.

      "The lookup is the only thing added to a path that is otherwise
      fire-and-forget, and a database blip must not turn a payment the gateway
      has already confirmed into a 500 that the sender retries forever."

      `undefined` means "do not redirect" for BOTH cases — an unmatched
      transaction and an unreadable row — so the difference is in the log, which
      is why the error is asserted by message here rather than by status alone.
    */
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    findByTransactionId.mockRejectedValue(new Error('database is down'));

    const res = await postAsBrowser('text/html');

    expect(res.status).toBe(202);
    expect(res.headers.location).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: TRANSACTION_ID }),
      expect.stringContaining('Could not read the checkout intent'),
    );
    // The dispatch already happened and is not undone by the failed lookup.
    expect(processWebhook).toHaveBeenCalledTimes(1);
  });

  it('leaves the gateway\'s own JSON callback on the 202, without even reading the intent', async () => {
    /*
      ★ THE 202 IS UNCHANGED. That path works, the sender depends on it, and the
      branch cannot reach it unless `Accept` names HTML.

      Asserted as the body AND the absence of the lookup: a matching intent is
      sitting right there, so a stray read would prove the branch had started to
      be reachable from a server-to-server caller.
    */
    const res = await request(app)
      .post('/api/v1/webhooks/amber-pay')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('Accept', 'application/json')
      .send(REAL_FORM_CALLBACK);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'accepted' });
    expect(res.headers.location).toBeUndefined();
    expect(findByTransactionId).not.toHaveBeenCalled();
  });

  it('leaves a wildcard `Accept` on the 202 too — curl and every probe send one', async () => {
    /*
      WHY NOT `req.accepts(['json', 'html'])`. Express answers with the first
      entry it likes, and a wildcard matches BOTH: ordering html first would send
      every server-to-server callback to a redirect, json first would send every
      real customer a JSON body. "Neither is a tiebreak, so neither is used" —
      which is only true if the wildcard is treated as what it is, a caller that
      has said nothing about HTML.
    */
    const res = await postAsBrowser('*/*');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'accepted' });
    expect(res.headers.location).toBeUndefined();
    expect(findByTransactionId).not.toHaveBeenCalled();
  });

  it('still recognises a browser that qualifies `text/html` with a q-value', async () => {
    /*
      ★ THE PARSE IS HAND-ROLLED, SO IT IS PINNED HERE.

      "Parsed by hand rather than with a header library because the only question
      is whether `text/html` appears among the accepted types, and a comma-split
      with a `;q=` tail stripped is the whole of what that needs."

      Every real browser sends a weighted list like this, so a parse that stopped
      at the first `;` — or that compared the raw entry including its parameters —
      would fail exactly the caller this branch exists for, and would do it
      silently: the customer would get the raw `{"status":"accepted"}`.
    */
    const res = await postAsBrowser('text/html;q=0.9,application/xhtml+xml,application/xml;q=0.8,*/*;q=0.5');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      joinUrl(env.APP_BASE_URL, `#/payment-return?token=${encodeURIComponent(STATUS_TOKEN)}`),
    );
  });
});