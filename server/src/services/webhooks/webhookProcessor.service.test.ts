import { WebhookProcessor } from './webhookProcessor.service.js';
import { EventLog } from '../events/eventLog.service.js';
import { FailureTracker } from '../events/failureTracker.service.js';
import { QuickBooksAdaptor } from '../adaptors/quickbooks.service.js';
import { AdaptorAuthError, AdaptorConnectionError } from '../adaptors/errors.js';
import { sealExpectedCharge } from '../gateway/amberPayWire.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import type { WebhookEvent } from '../../types/gateway.js';
import type {
  AccountingAdaptor,
  CustomerMatchConfig,
  PushResult,
} from '../../types/adaptor.js';
import type { GatewayTransactionStatus } from '../gateway/transactionStatus.service.js';
import type {
  AdaptorResolver,
  WebhookProcessorOverrides,
} from './webhookProcessor.service.js';

const collectedEvent: WebhookEvent = {
  id: 'w1',
  type: 'payment.collected',
  reference: 'ref-0001',
  status: 'collected',
  at: '2026-01-01T00:00:00.000Z',
};

/*
  A configured matching rule, supplied by DEFAULT to every processor in this
  file. It is a test override rather than a change to the real settings row
  because the alternative — a suite that has to configure a database to assert
  a webhook handler — is a suite that fails for reasons unrelated to the code
  being tested. The UNCONFIGURED path has its own test below, because "refuses
  rather than guessing" is a behaviour worth pinning rather than a nuisance to
  work around.
*/
const MATCH: CustomerMatchConfig = {
  strategy: 'customField',
  mode: 'exact',
  fieldName: 'Student ID',
  depositAccountId: null,
};

const applied: PushResult = {
  externalRef: 'pay-1',
  at: '2026-01-01T00:00:00.000Z',
  invoiceRefs: ['inv-1'],
  reconciliationRequired: false,
  matchedBy: 'customField',
  alreadyApplied: false,
  verified: true,
};

/**
 * A sealed charge, as the gateway signed it.
 *
 * The push is handed the amount the customer was CHARGED, read from this row —
 * never the invoice balance. A processor test that did not provide one would
 * (rightly) refuse to push, so every harness in this file answers it.
 */
function defaultCharges(amount = '250.00') {
  return {
    findExpectedChargeByTransactionId: jest.fn(async () => ({
      expectedSealed: sealExpectedCharge(amount, 'JMD'),
    })),
  };
}

/**
 * A QuickBooks that answers the whole pipeline.
 *
 * The real adaptor is used in one test on purpose — it is the only place the
 * connection, the matching and the write are exercised together. That test used
 * to stub the transport with a blanket `{status:200}`, which is why it passed
 * against an endpoint that does not exist; a pipeline needs its stages
 * answered by name.
 */
function quickBooksScript() {
  const transport = jest.fn(async (_method: string, url: string) => {
    const statement = decodeURIComponent(String(url).split('query=')[1]?.split('&')[0] ?? '');
    if (statement.includes('from Customer')) {
      return {
        status: 200,
        body: {
          QueryResponse: {
            Customer: [
              { Id: 'cust-1', CustomField: [{ Name: 'Student ID', StringValue: 'ref-0001' }] },
            ],
          },
        },
      };
    }
    if (statement.includes('from Invoice where CustomerRef')) {
      return {
        status: 200,
        body: { QueryResponse: { Invoice: [{ Id: 'inv-1', DueDate: '2026-02-01', Balance: 250 }] } },
      };
    }
    if (statement.includes('from Payment')) {
      return { status: 200, body: { QueryResponse: { Payment: [] } } };
    }
    if (String(url).endsWith('/payment')) {
      return { status: 200, body: { Payment: { Id: 'pay-1' } } };
    }
    if (String(url).includes('/invoice/')) {
      return { status: 200, body: { Invoice: { Id: 'inv-1', Balance: 0 } } };
    }
    return { status: 200, body: {} };
  });
  return { transport };
}

/** Build a processor carrying the default matching rule. */
function buildProcessor(
  eventLog: EventLog,
  failureTracker: FailureTracker,
  resolver: AdaptorResolver,
  pushTimeoutMs = 5000,
  activeAdaptorId?: 'quickbooks' | 'sage',
  overrides: WebhookProcessorOverrides = { matchConfig: MATCH },
): WebhookProcessor {
  return new WebhookProcessor(
    eventLog,
    failureTracker,
    resolver,
    pushTimeoutMs,
    activeAdaptorId,
    undefined,
    undefined,
    // The charge store is answered by default so a push has a figure to apply;
    // a test that wants to exercise a MISSING charge overrides it explicitly.
    { charges: defaultCharges(), ...overrides },
  );
}

function makeAdaptor(overrides?: Partial<AccountingAdaptor>): AccountingAdaptor {
  return {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockResolvedValue('disconnected'),
    pushCompletedPayment: jest.fn().mockResolvedValue(applied),
    pullSyncStatus: jest.fn(),
    healthCheck: jest.fn(),
    ...overrides,
  };
}

describe('the push target is configured, not assumed', () => {
  it('resolves which accounting system to push to instead of defaulting to QuickBooks', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const resolver = { get: jest.fn().mockReturnValue(makeAdaptor()) };
    // No adaptor id passed: the processor must ask configuration.
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);

    // A Sage deployment used to push its completed payments to QuickBooks,
    // because the class defaulted to the literal 'quickbooks'.
    expect(resolver.get).toHaveBeenCalledWith(env.ADAPTOR_ID);
  });

  it('still honours an explicitly supplied adaptor id (the test seam)', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const resolver = { get: jest.fn().mockReturnValue(makeAdaptor()) };
    const processor = buildProcessor(eventLog, failureTracker, resolver, 5000, 'sage');

    await processor.processWebhook(collectedEvent);

    expect(resolver.get).toHaveBeenCalledWith('sage');
  });

  it('files the singleton\'s records under the configured organization, not a literal', async () => {
    /*
      The bug this pins was silent: the singleton passed the literal 'org-1' as
      its organization, which OVERRODE the configured default (an explicit
      argument beats a default parameter). Every row it wrote was then invisible
      to the organization that owned it — no error anywhere, just a console that
      read empty for everyone except a wildcard super admin.
    */
    const original = process.env.ORGANIZATION_ID;
    process.env.ORGANIZATION_ID = 'org-check';
    try {
      // A fresh module registry, so the configuration is parsed again with the
      // value above and the singleton is constructed against it.
      jest.resetModules();
      const fresh = await import('./webhookProcessor.service.js');
      const scope = (fresh.webhookProcessor as unknown as { organizationId: string })
        .organizationId;

      expect(scope).toBe('org-check');
    } finally {
      process.env.ORGANIZATION_ID = original;
    }
  });
});

describe('WebhookProcessor', () => {
  it('records a collected event and pushes to the adaptor', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);

    const events = await eventLog.list(['org-1']);
    // The complete pipeline trail for one collection: the money moved, the
    // notification was ingested, and the record reached the accounting system.
    // Compared sorted: `list` orders newest-first by timestamp, and two events
    // written inside the same millisecond keep insertion order instead.
    expect(events.map((e) => e.type).sort()).toEqual([
      'collected',
      'record-updated',
      'webhook-received',
    ]);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
    expect(await failureTracker.list(['org-1'])).toHaveLength(0);
  });

  it('hands the adaptor the amount the gateway CHARGED, read from the sealed checkout', async () => {
    /*
      ★ THE FIGURE CROSSES THE PRIVACY BOUNDARY AS AN ARGUMENT, NOT A FIELD.

      It is what was charged, keyed by our transaction id, and it is the only
      number the ledger may apply. Asserting it here is the whole point: a push
      that received `undefined`, a default, or the invoice balance would satisfy
      every other test in this file.
    */
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const charges = defaultCharges('137.25');
    const processor = buildProcessor(
      eventLog,
      failureTracker,
      { get: jest.fn().mockReturnValue(adaptor) },
      5000,
      undefined,
      { matchConfig: MATCH, charges },
    );

    await processor.processWebhook(collectedEvent);

    expect(charges.findExpectedChargeByTransactionId).toHaveBeenCalledWith(
      env.ORGANIZATION_ID,
      collectedEvent.id,
    );
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledWith(
      expect.objectContaining({ id: collectedEvent.id }),
      MATCH,
      '137.25',
    );
    expect(await failureTracker.list(['org-1'])).toHaveLength(0);
  });

  it('refuses the push when the charged amount cannot be found — it never guesses', async () => {
    /*
      Falling back to an invoice balance is the original defect: a partial
      payment recorded as the full outstanding amount. A refusal is visible and
      fixable; a plausible wrong figure is invisible until the books disagree.
    */
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const processor = buildProcessor(
      eventLog,
      failureTracker,
      { get: jest.fn().mockReturnValue(adaptor) },
      5000,
      undefined,
      {
        matchConfig: MATCH,
        charges: { findExpectedChargeByTransactionId: jest.fn(async () => undefined) },
      },
    );

    await processor.processWebhook(collectedEvent);

    expect(adaptor.pushCompletedPayment).not.toHaveBeenCalled();
    const failures = await failureTracker.list(['org-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.title).toMatch(
      /amount this payment was charged could not be found/i,
    );
    // And nothing reached the ledger's terminal stage.
    expect((await eventLog.list(['org-1'])).map((e) => e.type)).not.toContain(
      'record-updated',
    );
  });

  it('connects the adaptor before pushing (real adaptor)', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const scripted = quickBooksScript();
    const adaptor = new QuickBooksAdaptor(scripted.transport);
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);

    expect(await adaptor.status()).toBe('connected');
    expect(scripted.transport).toHaveBeenCalled();
    expect(await failureTracker.list(['org-1'])).toHaveLength(0);
  });

  it('uses the configured active adaptor id', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor({ id: 'sage', name: 'Sage' });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver, 5000, 'sage');

    await processor.processWebhook(collectedEvent);

    expect(resolver.get).toHaveBeenCalledWith('sage');
  });

  /*
    ★ THE WRITE THE CUSTOMER'S PAGE IS BUILT ON.

    "Record what the gateway reported ... This is the write the customer-facing
    page is built on. It is a write, not a read, and it happens on the webhook's
    own path; the status endpoint itself never calls it."

    So without these the whole status feature reads from a column nothing in this
    file ever writes, and `PaymentStatusService` would be asserting against
    fixtures rather than against the pipeline. The idempotency of this write is
    the store's (`WHERE settled_at IS NULL`), and it is asserted there.
  */
  describe('the gateway\'s verdict is recorded where the customer can read it', () => {
    function withOutcomes(extra: WebhookProcessorOverrides = {}) {
      /*
        ★ `true`, because THIS delivery is the one that settled the payment. The
        store answers that question and the processor writes the lifecycle events
        only for the delivery that moved it — see "writes the facts ONCE" below
        for what `false` buys. A stub answering `undefined` would silence every
        event in this block while still passing a test that only reads the call.
      */
      const outcomes = { recordOutcome: jest.fn().mockResolvedValue(true) };
      const processor = buildProcessor(
        new EventLog(),
        new FailureTracker(),
        { get: jest.fn().mockReturnValue(makeAdaptor()) },
        5000,
        undefined,
        { matchConfig: MATCH, outcomes, ...extra },
      );
      return { outcomes, processor };
    }

    it('writes a collected verdict under the deployment\'s organization', async () => {
      const { outcomes, processor } = withOutcomes();

      await processor.processWebhook(collectedEvent);

      expect(outcomes.recordOutcome).toHaveBeenCalledWith({
        // The organization is the CONFIGURED one, read from the environment — the
        // same class of bug the singleton once had, where a literal silently
        // outranked the default and wrote every row where no operator could see
        // it.
        organizationId: env.ORGANIZATION_ID,
        // The gateway's echoed transaction id: the correlation the whole
        // checkout_intents table exists for.
        transactionId: 'w1',
        outcome: 'collected',
        // A success has nothing to explain.
        failureReason: null,
      });
    });

    it('writes a failure with the gateway\'s OWN words, and still files it', async () => {
      const { outcomes, processor } = withOutcomes({
        // The gateway has nothing on this one, so the callback's own words stand —
        // the enrichment PREFERS the status API's reason, it never replaces one.
        statuses: { lookup: jest.fn().mockResolvedValue(undefined) },
      });
      const declined: WebhookEvent = {
        id: 'w-fail-1',
        type: 'payment.failed',
        reference: null,
        status: 'failed',
        failureReason: 'Invalid transaction',
        at: '2026-01-01T00:00:00.000Z',
      };

      await processor.processWebhook(declined);

      expect(outcomes.recordOutcome).toHaveBeenCalledWith({
        organizationId: env.ORGANIZATION_ID,
        transactionId: 'w-fail-1',
        outcome: 'failed',
        // "Passed straight through rather than re-cleaned here, because two
        // sanitisation passes would be two places to keep honest and the one
        // that faces the wire is the one that should do it" — the schema in
        // `amberpay.service.ts` has already stripped and capped it.
        failureReason: 'Invalid transaction',
      });
    });

    it('settles NOTHING for a delivery that is not a verdict about a payment', async () => {
      const { outcomes, processor } = withOutcomes();

      // `unknown` is an absence of a verdict, so no callback can write it — a
      // column holding the string 'unknown' would make "we don't know"
      // indistinguishable from "the gateway said unknown", which is exactly what
      // the CHECK in migration 009 and this union both exist to prevent.
      await processor.processWebhook({
        id: 'w-init-1',
        type: 'payment.initiated',
        reference: 'ref-0002',
        status: 'initiated',
        at: '2026-01-01T00:00:00.000Z',
      });

      expect(outcomes.recordOutcome).not.toHaveBeenCalled();
    });
  });

  it('ignores duplicate webhook ids', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);
    await processor.processWebhook(collectedEvent);

    expect(await eventLog.list(['org-1'])).toHaveLength(3);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
  });

  it('does NOT dedup a failed webhook — a retry reprocesses it (M2)', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    // First delivery fails (adaptor push throws).
    await processor.processWebhook(collectedEvent);
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);

    // Retry must reprocess (not be deduped): the failure is recorded again.
    await processor.processWebhook(collectedEvent);
    expect(await failureTracker.list(['org-1'])).toHaveLength(2);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(2);
  });

  it('rejects a CONCURRENT duplicate — the second delivery never reaches the adaptor', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    let releasePush!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest.fn().mockImplementation(async () => {
        // Hold the first delivery inside the push so the second arrives while
        // the first is still in flight — the window the old
        // hasProcessed-then-markProcessing pair could not close.
        await gate;
        return applied;
      }),
    });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    const first = processor.processWebhook(collectedEvent);
    const second = processor.processWebhook(collectedEvent);
    releasePush();
    await Promise.all([first, second]);

    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
    expect(await eventLog.list(['org-1'])).toHaveLength(3);
    expect(await failureTracker.list(['org-1'])).toHaveLength(0);
  });

  it('pushes a refund with the refunded status and logs its own event type', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook({
      ...collectedEvent,
      id: 'w-refund',
      type: 'payment.refunded',
      status: 'refunded',
    });

    const events = await eventLog.list(['org-1']);
    expect(events.map((e) => e.type).sort()).toEqual(['payment-refunded', 'record-updated']);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'refunded' }),
      MATCH,
      '250.00',
    );
  });

  it('dedups a successful webhook on a later retry (M2)', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);
    await processor.processWebhook(collectedEvent);

    expect(await eventLog.list(['org-1'])).toHaveLength(3);
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
  });

  it('records a critical failure when the adaptor push fails, without throwing', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    await expect(processor.processWebhook(collectedEvent)).resolves.toBeUndefined();

    const failures = await failureTracker.list(['org-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe('critical');
  });

  it('names a credential refusal as a credential refusal, not as a matching failure', async () => {
    /*
      ★ THE TITLE IS THE DIAGNOSIS.

      A dead grant stops every payment BEFORE any customer matching runs, yet it
      used to be filed as a generic "payment push to adaptor failed" — the same
      sentence an unmatched display name produces. An operator reading that goes
      and rewrites a correct matching rule while the connection has never been
      authorized. The reason has to survive into the dashboard.
    */
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest
        .fn()
        .mockRejectedValue(
          new AdaptorAuthError(
            'QuickBooks Online: token exchange failed (status 400: Incorrect or invalid refresh token)',
          ),
        ),
    });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver);

    await processor.processWebhook(collectedEvent);

    const [failure] = await failureTracker.list(['org-1']);
    expect(failure?.title).toMatch(/credentials/i);
    expect(failure?.title).toMatch(/invalid refresh token/i);
  });

  it('records a critical failure when the adaptor push times out', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return applied;
      }),
    });
    const resolver = { get: jest.fn().mockReturnValue(adaptor) };
    const processor = buildProcessor(eventLog, failureTracker, resolver, 5);

    await processor.processWebhook(collectedEvent);

    const failures = await failureTracker.list(['org-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe('critical');
  });

  it('records a declined lifecycle event and a failure for declined payments', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const processor = new WebhookProcessor(eventLog, failureTracker, { get: jest.fn() });

    await processor.processWebhook({
      ...collectedEvent,
      type: 'payment.declined',
      status: 'failed',
    });

    const events = await eventLog.list(['org-1']);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('payment-declined');
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);
  });

  it('records a payment-failed lifecycle event for failed payments', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const processor = new WebhookProcessor(eventLog, failureTracker, { get: jest.fn() });

    await processor.processWebhook({
      ...collectedEvent,
      type: 'payment.failed',
      status: 'failed',
    });

    const events = await eventLog.list(['org-1']);
    expect(events[0]?.type).toBe('payment-failed');
  });
});

/**
 * ★ THE DELIVERY THAT NAMES NO CUSTOMER.
 *
 * The gateway registers one url as BOTH its callback and its redirect, so every
 * payment arrives twice: once server-to-server, once from the customer's browser.
 * The callback carries a `StudentID` only when the browser supplied one, and a
 * card payment made on the gateway's own page supplies none — so the second
 * arrival is often the only delivery that names anyone.
 */
const CUSTOMERLESS: WebhookEvent = {
  id: 'w-twin-0001',
  type: 'payment.collected',
  reference: null,
  status: 'collected',
  at: '2026-10-16T21:17:10.000Z',
};

/** What the gateway's own status API answered, minus anything it must not carry. */
function gatewaySays(overrides: Partial<GatewayTransactionStatus> = {}): GatewayTransactionStatus {
  return {
    customerReference: 'STU025',
    reasonCode: null,
    responseCode: null,
    reasonDescription: null,
    transactionIdentifier: '012072AB-756C-4D3e-85BF-EEF7A44D4969',
    ...overrides,
  };
}

describe('the customer the callback did not carry', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves the customer with the gateway, and pushes the payment', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const lookup = jest.fn().mockResolvedValue(gatewaySays());
    const processor = buildProcessor(
      eventLog,
      failureTracker,
      { get: jest.fn().mockReturnValue(adaptor) },
      5000,
      undefined,
      { matchConfig: MATCH, statuses: { lookup } },
    );

    await processor.processWebhook(CUSTOMERLESS);

    // Under OUR organization, for the transaction the gateway echoed — the same
    // correlation every other read of this table is keyed on.
    expect(lookup).toHaveBeenCalledWith(env.ORGANIZATION_ID, CUSTOMERLESS.id);
    // The payment is applied on the value WE sent as the checkout's customer,
    // coming back to us — not on a guess, and not on the gateway's timestamped
    // OrderId, which can never identify anybody.
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledWith(
      expect.objectContaining({ matchValue: 'STU025', transactionId: CUSTOMERLESS.id }),
      MATCH,
      '250.00',
    );
    // And the lifecycle events are filed under that same reference, so the
    // ledger's ref matches the customer the payment was pushed for.
    const events = await eventLog.list(['org-1']);
    expect(events.map((e) => e.type).sort()).toEqual([
      'collected',
      'record-updated',
      'webhook-received',
    ]);
    expect(new Set(events.map((e) => e.ref))).toEqual(new Set(['STU025']));
    expect(await failureTracker.list(['org-1'])).toHaveLength(0);
  });

  it('never asks the gateway about a delivery that already named its customer', async () => {
    /*
      ★ NO WEBHOOK PAYS A ROUND TRIP IT DOES NOT NEED.

      The common case is a callback that arrived complete, and every one of those
      would otherwise cost a server-to-server call, a database read of a sealed
      figure and a signature — to be told what the body already said.
    */
    const lookup = jest.fn().mockResolvedValue(gatewaySays());
    const processor = buildProcessor(
      new EventLog(),
      new FailureTracker(),
      { get: jest.fn().mockReturnValue(makeAdaptor()) },
      5000,
      undefined,
      { matchConfig: MATCH, statuses: { lookup } },
    );

    await processor.processWebhook(collectedEvent);

    expect(lookup).not.toHaveBeenCalled();
  });

  it('falls back to the "cannot be applied" finding when the gateway is unreachable', async () => {
    /*
      ★ A GATEWAY OUTAGE MUST NOT BECOME A NEW FAILURE MODE.

      This is the delivery the enrichment exists for, and it is the one the
      enrichment is not allowed to make worse: the lookup throws, the webhook
      still completes what it always did — the money is recorded, and a critical
      finding says the payment cannot be applied to an invoice. No 500, no lost
      event, no new reason the gateway is simply unreachable.
    */
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const processor = buildProcessor(
      new EventLog(),
      failureTracker,
      { get: jest.fn().mockReturnValue(adaptor) },
      5000,
      undefined,
      {
        matchConfig: MATCH,
        statuses: {
          // The ONLY error the status path raises for a fault, and it quotes the
          // status and nothing else — which is what the logging below relies on.
          lookup: jest.fn().mockRejectedValue(
            new AdaptorConnectionError(
              'Amber Pay could not report the status of this transaction (status 502)',
            ),
          ),
        },
      },
    );

    await expect(processor.processWebhook(CUSTOMERLESS)).resolves.toBeUndefined();

    // No customer, so no push — the refusal is deliberate, not a crash.
    expect(adaptor.pushCompletedPayment).not.toHaveBeenCalled();
    const failures = await failureTracker.list(['org-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe('critical');
    // Today's behaviour, by its own words: the refusal is the finding.
    const loggedErrors = error.mock.calls.flatMap((call) => {
      const payload = call[0] as { err?: unknown } | undefined;
      return payload?.err instanceof Error ? [payload.err.message] : [];
    });
    expect(
      loggedErrors.some((message) => message.includes('cannot be applied to an invoice')),
    ).toBe(true);
    // The unreachable lookup is logged as IDENTITY ONLY. The response it never
    // read is the PII-dense thing — a cardholder name, a padded card number, a
    // billing email and phone — and none of it may reach a log or a finding.
    const logged = warn.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(logged).toContain(CUSTOMERLESS.id);
    expect(logged).not.toMatch(/CardHolderName|PaddedCardNo|BillingEmail|BillingPhone/);
  });

  it('prefers the gateway\'s composed reason over the callback\'s bare message', async () => {
    const outcomes = { recordOutcome: jest.fn().mockResolvedValue(true) };
    const processor = buildProcessor(
      new EventLog(),
      new FailureTracker(),
      { get: jest.fn().mockReturnValue(makeAdaptor()) },
      5000,
      undefined,
      {
        matchConfig: MATCH,
        outcomes,
        statuses: {
          lookup: jest.fn().mockResolvedValue(
            gatewaySays({ reasonCode: '12', responseCode: '12', reasonDescription: 'Invalid transaction' }),
          ),
        },
      },
    );

    await processor.processWebhook({
      ...CUSTOMERLESS,
      type: 'payment.failed',
      status: 'failed',
      // What the callback's ErrorMessage said. True, and useless on its own: the
      // code beside it is what a customer needs and what a bare decline omits.
      failureReason: 'Invalid transaction',
    });

    expect(outcomes.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: '12: Invalid transaction' }),
    );
  });

  /*
    ★★★ THE BEHAVIOUR THIS WHOLE TASK EXISTS FOR. ★★★

    Production showed two `Collected` lifecycle events for one payment, same
    reference, five seconds apart — because the push threw (nothing was
    authorized), the catch released the dedup claim, and the second delivery was
    therefore free to re-write the facts.

    So both halves are asserted, and the second one is the half a dedup-only test
    would miss: the push is attempted TWICE, because that is the only part of
    this pipeline with somewhere to go when it fails, and it is what succeeds
    once QuickBooks is connected.
  */
  it('writes the facts ONCE and still retries the push', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const outcomes = {
      // The store's own idempotency, answering the question it is now asked:
      // this call settled the payment; that later one found it already settled.
      recordOutcome: jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    };
    let attempts = 0;
    const adaptor = makeAdaptor({
      pushCompletedPayment: jest.fn().mockImplementation(async () => {
        attempts += 1;
        // The production trigger, exactly: the accounting system is configured
        // but not authorized, so the push throws however many times it is tried.
        if (attempts === 1) throw new Error('boom');
        return applied;
      }),
    });
    const processor = buildProcessor(
      eventLog,
      failureTracker,
      { get: jest.fn().mockReturnValue(adaptor) },
      5000,
      undefined,
      { matchConfig: MATCH, outcomes },
    );

    await processor.processWebhook(collectedEvent);
    await processor.processWebhook(collectedEvent);

    // ONE settlement, asked about twice. The second delivery saw the payment was
    // already settled and therefore said nothing about it again.
    expect(outcomes.recordOutcome).toHaveBeenCalledTimes(2);
    expect(outcomes.recordOutcome.mock.calls[0]).toEqual(outcomes.recordOutcome.mock.calls[1]);

    // THE FACTS, ONCE. Two `collected` and two `webhook-received` is what the
    // operator saw, and it reads as two payments when it is one.
    const events = await eventLog.list(['org-1']);
    const types = events.map((e) => e.type);
    expect(types.filter((type) => type === 'collected')).toHaveLength(1);
    expect(types.filter((type) => type === 'webhook-received')).toHaveLength(1);
    // And the retry's success is on the record — the terminal stage of the flow
    // is written by whichever push actually landed.
    expect(types).toContain('record-updated');

    // ★ THE RETRY, WHICH A DEDUP-ONLY TEST WOULD NOT CATCH.
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(2);
    // The first attempt's finding, and only that one: the retry worked, so
    // nothing new is wrong.
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);
  });

  it('lets a LATER delivery that names the customer complete the push', async () => {
    /*
      ★ THE INTENT DOCUMENTED BESIDE THE REFUSAL, AND IT MUST SURVIVE.

      "because `processWebhook` releases the claim on failure, the delivery stays
      retryable in case a later callback does carry the identifier" — so a
      genuinely NEW delivery carrying information the first one lacked still
      finishes the job. Here the gateway knows nothing on the first arrival and
      the second delivery names the customer outright.
    */
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const outcomes = {
      recordOutcome: jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    };
    const lookup = jest.fn().mockResolvedValue(undefined);
    const adaptor = makeAdaptor();
    const processor = buildProcessor(
      eventLog,
      failureTracker,
      { get: jest.fn().mockReturnValue(adaptor) },
      5000,
      undefined,
      { matchConfig: MATCH, outcomes, statuses: { lookup } },
    );

    await processor.processWebhook(CUSTOMERLESS);
    await processor.processWebhook({ ...CUSTOMERLESS, reference: 'STU025' });

    // The second delivery needed no gateway round trip — it arrived complete.
    expect(lookup).toHaveBeenCalledTimes(1);
    // The FIRST delivery never reached the adaptor: with no customer there is
    // nothing to match, so it refused before the push rather than guessing. The
    // second one is what actually applies the payment, on the reference it named.
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledTimes(1);
    expect(adaptor.pushCompletedPayment).toHaveBeenLastCalledWith(
      expect.objectContaining({ matchValue: 'STU025' }),
      MATCH,
      '250.00',
    );
    // The facts were still written once, by the delivery that settled them, and
    // the push that finally landed left the flow's terminal stage behind.
    const types = (await eventLog.list(['org-1'])).map((e) => e.type);
    expect(types.filter((type) => type === 'collected')).toHaveLength(1);
    expect(types).toContain('record-updated');
    // And the first delivery's finding is still on file — the second one was not a
    // way of making it disappear, it was a way of finishing the job.
    expect(await failureTracker.list(['org-1'])).toHaveLength(1);
  });
});

describe('the customer matching rule', () => {
  it('hands the adaptor the configured rule rather than a default it chose', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const processor = buildProcessor(
      eventLog,
      failureTracker,
      { get: jest.fn().mockReturnValue(adaptor) },
    );

    await processor.processWebhook(collectedEvent);

    // The adaptor's behaviour depends entirely on this argument, so it is
    // asserted rather than assumed: a change here is a change to which ledger a
    // student's money lands in.
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledWith(
      expect.objectContaining({ matchValue: 'ref-0001' }),
      MATCH,
      '250.00',
    );
  });

  it('refuses to place a payment when no rule is configured', async () => {
    /*
      The failure mode this prevents is silent and expensive. A default strategy
      would decide, for every deployment, that a student's identifier is their
      name — and pay whichever ledger happened to answer. Refusing is visible;
      guessing is not.
    */
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const processor = buildProcessor(
      eventLog,
      failureTracker,
      { get: jest.fn().mockReturnValue(adaptor) },
      5000,
      undefined,
      { settings: { resolveMatchConfig: async () => null } },
    );

    await processor.processWebhook(collectedEvent);

    expect(adaptor.pushCompletedPayment).not.toHaveBeenCalled();
    const failures = await failureTracker.list(['org-1']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe('critical');
  });

  it('reads the rule from configuration rather than from the environment', async () => {
    const eventLog = new EventLog();
    const failureTracker = new FailureTracker();
    const adaptor = makeAdaptor();
    const stored: CustomerMatchConfig = {
      strategy: 'displayName',
      mode: 'contains',
      fieldName: null,
      depositAccountId: '35',
    };
    const resolveMatchConfig = jest.fn().mockResolvedValue(stored);
    const processor = buildProcessor(
      eventLog,
      failureTracker,
      { get: jest.fn().mockReturnValue(adaptor) },
      5000,
      undefined,
      { settings: { resolveMatchConfig } },
    );

    await processor.processWebhook(collectedEvent);

    expect(resolveMatchConfig).toHaveBeenCalled();
    expect(adaptor.pushCompletedPayment).toHaveBeenCalledWith(
      expect.anything(),
      stored,
      '250.00',
    );
  });
});
