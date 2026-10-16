import express from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import { createPaymentRouter } from './payments.js';
import { errorHandler, notFoundHandler } from '../middleware/errorHandler.js';
import { createInMemoryRepositories } from '../repositories/inMemory.js';
import { issueAccessToken } from '../utils/tokens.js';
import { forbiddenKeysIn } from '../test/privacy.js';
import { CheckoutService } from '../services/gateway/checkout.service.js';
import { sealExpectedCharge } from '../services/gateway/amberPayWire.js';
import type { Repositories } from '../types/repository.js';
import type { CheckoutIntentStore } from '../services/gateway/checkout.service.js';
import type { AdaptorResponse, HttpMethod } from '../types/adaptor.js';
import type { PolicyAttribute } from '../types/auth.js';
import type { CheckoutStatusRow } from '../services/payments/paymentStatus.service.js';

/**
 * A checkout that reaches no gateway and no database.
 *
 * `POST /payments` used to return a fabricated `linkUrl`; it now returns the
 * parameters the browser posts to the gateway, so the thing being stubbed is a
 * CheckoutService rather than a gateway.
 */
function stubCheckout(simulated = false): CheckoutService {
  const service = new CheckoutService(
    {
      async create() {
        /* nothing to store */
      },
      async findByTransactionId() {
        return undefined;
      },
    } satisfies CheckoutIntentStore,
    (async (_method: HttpMethod, _url: string): Promise<AdaptorResponse> => ({
      status: 200,
      body: { success: 'Y', Signature: 'c2ln' },
    })) as never,
    () => 'ABCDEFGH1234',
  );
  if (!simulated) return service;
  // `as unknown` because the stub replaces ONE method of a class: the object
  // deliberately has none of the instance state, and saying so through `unknown`
  // is more honest than widening CheckoutService for a test.
  return {
    create: async () => ({
      checkoutUrl: 'https://staging-payment.myamberpay.com/gateway/v1/standard-checkout',
      params: {
        ClientId: 'test-amber-client-id',
        TransactionId: 'ABCDEFGH1234',
        CurrencyCode: 'JMD' as const,
        Amount: 25000,
        Signature: 'c2ln',
        CustomerReference: 'STU0026',
        CustomerInvoice: 'N' as const,
        ReturnToMerchant: 'Y' as const,
        AutoRedirect: 'Y' as const,
      },
      transactionId: 'ABCDEFGH1234',
      simulated: true,
    }),
  } as unknown as CheckoutService;
}

/** The body `POST /payments` now takes: a customer, a figure, and an org. */
const body = {
  invoiceId: 'inv-1',
  studentId: 'STU0026',
  amount: '250.00',
  currency: 'JMD' as const,
};

function token(policy: PolicyAttribute[]): string {
  return issueAccessToken({ id: 'u1', email: 'user@example.com', policyAttributes: policy });
}

function buildApp(repositories: Repositories, checkout: CheckoutService = stubCheckout()) {
  return createApp({ repositories, checkout });
}

const writePolicy: PolicyAttribute[] = [
  { scope: 'payments', organizationId: 'org-1', actions: ['read', 'write'] },
];

describe('payments routes', () => {
  it('rejects POST /payments without a token (401)', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories)).post('/api/v1/payments').send(body);
    expect(res.status).toBe(401);
  });

  it('rejects POST /payments when PBAC denies the organization (403)', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token([{ scope: 'payments', organizationId: 'org-9', actions: ['write'] }])}`)
      .send(body);
    expect(res.status).toBe(403);
  });

  it('creates a checkout and persists an operational payment (201)', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(typeof res.body.payment.id).toBe('string');
    expect(res.body.payment.status).toBe('initiated');
    // The transaction id the CHECKOUT minted, which is what the gateway will
    // echo on the callback.
    expect(res.body.payment.transactionId).toBe('ABCDEFGH1234');
    expect(res.body.checkout.transactionId).toBe('ABCDEFGH1234');
  });

  /*
    ★ THE ORGANIZATION IS OPTIONAL AND THAT MUST NOT COST THE CALLER ACCESS.

    `organizationId` is absent from this body — the console cannot read it, and
    the server already knows it. It used to be enough to break authorization:
    `organizationIdOf(req)` reads the body, falls back to the query string, and
    returns `''` when neither is present — an empty scope matching no policy
    attribute, so a perfectly authorized writer got 403 on every request.

    The regression is invisible to a test that always sends the field, which is
    why the fixture above omits it rather than carrying it "just in case".
  */
  it('authorizes a writer even though the body names no organization', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send(body);

    expect(body).not.toHaveProperty('organizationId');
    expect(res.status).toBe(201);
  });

  it('still refuses a body naming another organization', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send({ ...body, organizationId: 'org-elsewhere' });

    /*
      403, NOT 400 — and the distinction is the point.

      The request names a foreign organization, so `paymentScope` resolves to it
      and the caller's policy grants nothing there. Authorization refuses BEFORE
      the controller parses anything, which means the request never reaches the
      body validation at all. A 400 would have been the schema's answer if the
      controller had run first; that PBAC gets there first is the stronger
      property — a write aimed at another tenant is stopped by the tenant rule,
      not by a field check that could be reordered later.

      Either way it is refused, which is what matters.
    */
    expect(res.status).toBe(403);
  });

  it('returns a destination and parameters, not a link', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send(body);

    expect(res.status).toBe(201);
    // The gateway issues no URL a customer visits: it expects a signed POST and
    // answers with the form. So the response is where to go and what to send.
    expect(res.body.link).toBeUndefined();
    expect(res.body.checkout.checkoutUrl).toMatch(/standard-checkout$/);
    expect(res.body.checkout.params.CustomerReference).toBe('STU0026');
  });

  /*
    The figure goes out to the browser ONCE, inside the checkout, and is not
    attached to anything we keep. `forbiddenKeysIn` is the repository-wide guard
    on response shapes, so it is asserted here rather than trusted by inspection.
  */
  it('keeps the figure out of the payment entity', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send(body);

    expect(res.status).toBe(201);
expect(res.body.checkout.params.Amount).toBe('250.00');
expect(JSON.stringify(res.body.payment)).not.toContain('250.00');
  });

  it('omits the simulated flag for a genuine gateway checkout', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.checkout).not.toHaveProperty('simulated');
  });

  it('marks a checkout as simulated when it was fabricated locally', async () => {
    const repositories = createInMemoryRepositories();
    const res = await request(buildApp(repositories, stubCheckout(true)))
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token(writePolicy)}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.checkout.simulated).toBe(true);
  });

  it('accepts a non-uuid string invoiceId and round-trips it (201)', async () => {
    const repositories = createInMemoryRepositories();
    const app = buildApp(repositories);
    const auth = `Bearer ${token(writePolicy)}`;

    const created = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', auth)
      .send({ ...body, invoiceId: 'inv-abc-123' });

    expect(created.status).toBe(201);
    expect(created.body.payment.invoiceId).toBe('inv-abc-123');

    // Round-trip: the stored payment is retrievable with the same string id.
    const found = await request(app)
      .get(`/api/v1/payments/${created.body.payment.id}`)
      .query({ organizationId: 'org-1' })
      .set('Authorization', auth);
    expect(found.status).toBe(200);
    expect(found.body.payment.invoiceId).toBe('inv-abc-123');
  });

  it('returns an operational payment by id (200) and 404 for unknown', async () => {
    const repositories = createInMemoryRepositories();
    const payment = await repositories.payments.create({
      id: 'pay-1',
      invoiceId: 'inv-1',
      organizationId: 'org-1',
      transactionId: 'ref-0001',
      status: 'collected',
      processedAt: '2026-01-01T00:00:00.000Z',
    });
    const app = buildApp(repositories);
    const auth = `Bearer ${token(writePolicy)}`;

    const found = await request(app)
      .get(`/api/v1/payments/${payment.id}`)
      .query({ organizationId: 'org-1' })
      .set('Authorization', auth);
    expect(found.status).toBe(200);
    expect(found.body.payment.status).toBe('collected');
    expect(forbiddenKeysIn(found.body)).toEqual([]);

    const missing = await request(app)
      .get('/api/v1/payments/does-not-exist')
      .query({ organizationId: 'org-1' })
      .set('Authorization', auth);
    expect(missing.status).toBe(404);
  });

  it('returns 404 for a payment belonging to another org (C1)', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.payments.create({
      id: 'pay-org2',
      invoiceId: 'inv-2',
      organizationId: 'org-2',
      transactionId: 'ref-0002',
      status: 'collected',
      processedAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await request(buildApp(repositories))
      .get('/api/v1/payments/pay-org2')
      .query({ organizationId: 'org-1' })
      .set('Authorization', `Bearer ${token(writePolicy)}`);

    expect(res.status).toBe(404);
  });
});

/*
  ★ THE ONLY ROUTE ON THIS SERVER WITH NO SESSION, AND IT IS NOT AN OMISSION.

  Everything above is an operator acting inside a policy. This one is a customer
  who has just handed over a card: no session, no uuid, no credentials — because
  the gateway redirects them here through the webhook url, "the one address they
  can be given". "The 256-bit token in the path IS the authorisation."

  Which is precisely why these tests exist: the first one would still pass if a
  `requireAuth` were added to this route by accident, and so would every other
  test in the repository, while the customer page the gateway redirects to
  started answering 401 in production. The narrowness is the security property.

  The router is built directly rather than through `createApp`, because
  `createApp` has no status-store seam: `createPaymentRouter` defaults it to the
  Postgres store, and a test that let it would open a real pool.
*/
describe('GET /payments/status/:token — the public read', () => {
  const TOKEN = 'kQ3vZx1NpJ7cR2wYbT9mL4dH6fG0sA8uE1iO5nP7qRj';

  let store: { findByStatusToken: jest.Mock<Promise<CheckoutStatusRow | undefined>, [string]> };
  let app: express.Express;

  beforeEach(() => {
    store = {
      findByStatusToken: jest.fn<Promise<CheckoutStatusRow | undefined>, [string]>().mockResolvedValue(
        undefined,
      ),
    };
    app = express();
    app.use(
      '/api/v1',
      createPaymentRouter({
        payments: createInMemoryRepositories().payments,
        checkout: stubCheckout(),
        statusStore: store,
      }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
  });

  function collect() {
    store.findByStatusToken.mockResolvedValue({
      transactionId: 'E09KUZXK6BZJ',
      expectedSealed: sealExpectedCharge('250.00', 'JMD'),
      outcome: 'collected',
      failureReason: null,
    });
  }

  it('answers a caller with NO session, because the token is the authorisation', async () => {
    collect();

    // No Authorization header at all — and this is the assertion, not the setup.
    const res = await request(app).get(`/api/v1/payments/status/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'collected',
      reference: 'E09KUZXK6BZJ',
      reason: null,
      amount: '250.00',
      currency: 'JMD',
    });
    // The token in the PATH is the whole of the credential, and it is the token
    // the store is asked for — nothing else identifies the payment.
    expect(store.findByStatusToken).toHaveBeenCalledWith(TOKEN);
  });

  it('still requires a session for every OTHER read on this router', async () => {
    // The pair to the test above. Without `requireAuth` on this one route the
    // anonymous read above is a gap; without it on the others, it is a breach.
    const res = await request(app).get('/api/v1/payments/pay-1');

    expect(res.status).toBe(401);
  });

  it('answers 400 for a token that is not the shape of one we mint', async () => {
    /*
      "A MALFORMED TOKEN IS A 400, THROWN BY THE SERVICE ... a malformed token is
      a client's bug worth telling it about."  Asserted as a 400 and not a 404
      because the endpoint deliberately distinguishes the two — and the store
      must never see it.
    */
    const res = await request(app).get('/api/v1/payments/status/not-a-status-token');

    expect(res.status).toBe(400);
    expect(store.findByStatusToken).not.toHaveBeenCalled();
  });

  it('answers 200 and `unknown` for a well-formed token that names nothing', async () => {
    /*
      ★ NO 404.

      "EVERYTHING ELSE IS A 200 ... a 404 there renders an error page for a
      payment that went through perfectly well."  This is the case the whole
      vocabulary exists for: a customer who has just paid, whose callback has not
      landed yet. It must look like waiting, because it is waiting.
    */
    const res = await request(app).get(`/api/v1/payments/status/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'unknown',
      reference: null,
      reason: null,
      amount: null,
      currency: null,
    });
  });
});
