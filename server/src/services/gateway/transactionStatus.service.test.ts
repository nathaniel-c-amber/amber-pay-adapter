/* The gateway's own account of a payment its callback did not describe.
 *
 * ★ WHY THE FIXTURE IS THE WHOLE RESPONSE, PII FIELDS INCLUDED.
 *
 * `readStatus` declares FIVE fields and the live body carries twenty. A fixture
 * built from the five would prove the parse and say nothing about the fifteen —
 * and the fifteen are the whole safety argument: nothing here declares them, so
 * they cannot be logged, recorded, or reach an event. So the keys are all here,
 * with values that are obviously synthetic, and the tests assert they do not come
 * out. (No assertion below quotes a card field, a token, or a contact detail: the
 * point is the KEYS being dropped, not the values being echoed.)
 *
 * ★ WHY THE SIGNATURE IS FAKED, NEVER COMPUTED.
 *
 * `/generatesignature` answers, so the signature used here is the gateway's
 * stand-in for it. What the tests care about is which figure the request was
 * signed OVER — so the signature endpoint records the body it was asked to sign
 * and the status endpoint records the signature it was handed, and the two are
 * compared.
 */

import {
  GatewayStatusService,
  gatewayFailureReason,
} from './transactionStatus.service.js';
import { AdaptorConnectionError } from '../adaptors/errors.js';
import { sealExpectedCharge } from './amberPayWire.js';
import { buildSignaturePath, buildStatusPath } from './gatewayEndpoints.js';
import { logger } from '../../utils/logger.js';
import type { ExpectedCharge } from './amberPayWire.js';
import type { GatewayStatusStore } from './transactionStatus.service.js';
import type { AdaptorResponse, HttpMethod } from '../../types/adaptor.js';

/** The signature the fake gateway returns for anything it is asked to sign. */
const SIGNATURE = 'ZG9uZS1ub3QtaW5mby1hbi1hbnktc2lnbmF0dXJlLXBsZWNl';

/** The transaction id the gateway echoed back on the probed callback. */
const TRANSACTION_ID = 'E09KUZXK6BZJ';
/** A second id, with its own stored figure. */
const OTHER_TRANSACTION_ID = 'P2TRX0000AB';
const ORGANIZATION_ID = 'org-1';
/** The customer WE sent as the checkout's `CustomerReference`. */
const CUSTOMER = 'STU025';

/**
 * The live `POST /gateway/v1/transactionstatus` response, field for field.
 *
 * Captured from the staging gateway on 2026-10-16. `Success`, `Results` and the
 * five read fields are reproduced exactly; the rest exist only so the narrowing
 * can be tested, and every one of their values is invented.
 */
const LIVE_RESPONSE = {
  Success: 'Y',
  Results: [
    {
      ClientId: 'quick_book_stage',
      TransactionDate: '2026-10-16T21:17:10Z',
      TransactionId: 'E09KUZXK6BZJ',
      OrderId: '17921677369780E09KUZXK6BZJ',
      TransactionStatus: 'Failed',
      PaymentStatus: 'Failed',
      AmountCharged: '25000',
      CurrencyCode: 'JMD',
      ReasonCode: '12',
      ResponseCode: '12',
      ReasonCodeDesc: 'Invalid transaction',
      TransactionIdentifier: '012072AB-756C-4D3e-85BF-EEF7A44D4969',
      CustomerReference: 'STU025',
      // ── Below here: the fifteen this file must not declare ───────────────
      CardHolderName: 'A Synthetic Nameholder',
      CardType: 'Visa',
      BillingEmail: 'nobody@example.invalid',
      BillingPhone: '0000000000',
      PaddedCardNo: '',
      CardToken: '',
      AuthCode: '',
      ReferenceNo: '',
      CustomMessage: '',
      AutoRedirect: 'Y',
      ReturnToMerchant: 'Y',
    },
  ],
};

/**
 * The five names `readStatus` maps onto.
 *
 * Spelled out, and compared against the fixture below, because the number of
 * wire fields this service reads is a deliberate narrowing rather than a
 * convenience: `DROPPED_FIELDS` is derived from the fixture as "everything the
 * wire carries that is not one of these", so a field added to the fixture has to
 * be classified as read or dropped rather than quietly ignored.
 */
const DECLARED_FIELDS = [
  'CustomerReference',
  'ReasonCode',
  'ResponseCode',
  'ReasonCodeDesc',
  'TransactionIdentifier',
];

/**
 * The wire fields this service must not declare.
 *
 * DERIVED from the fixture rather than listed, which is the opposite of a
 * hand-written allow-list: every field the live row carries is checked, so a
 * future field on the gateway cannot slip through by not being on a list. The
 * COUNT below pins the fixture, so the derivation cannot be defused by deleting
 * keys from it.
 */
const DROPPED_FIELDS = Object.keys(LIVE_RESPONSE.Results[0] as Record<string, unknown>).filter(
  (key) => !DECLARED_FIELDS.includes(key),
);

interface HarnessOptions {
  /**
   * Sealed figures by transaction id. Absent means "no intent recorded".
   *
   * Typed as the wire module's own `ExpectedCharge` rather than a shape written
   * out here, so a test fixture cannot drift from the thing it is standing in for
   * — and so this file declares no figure of its own (which `privacy.test.ts`
   * scans every interface in the tree for, quite rightly).
   */
  sealed?: Record<string, ExpectedCharge>;
  statusBody?: unknown;
  statusStatus?: number;
  signatureStatus?: number;
}

/**
 * A gateway that answers both calls, and remembers what each was asked.
 *
 * `signed` is the body `/generatesignature` was asked to sign and `sent` is the
 * body `/transactionstatus` was handed, so a test can compare the figure in the
 * signature against the figure in the request without reading either one's
 * internals.
 */
function harness(options: HarnessOptions = {}) {
  const sealed = options.sealed ?? { [TRANSACTION_ID]: { amount: '250.00', currency: 'JMD' as const } };
  const findExpectedChargeByTransactionId = jest.fn(
    async (organizationId: string, transactionId: string) => {
      const row = sealed[transactionId];
      if (row === undefined || organizationId !== ORGANIZATION_ID) return undefined;
      return { expectedSealed: sealExpectedCharge(row.amount, row.currency) };
    },
  );
  const store: GatewayStatusStore = { findExpectedChargeByTransactionId };

  const signed: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const transport = jest.fn(
    async (
      method: HttpMethod,
      path: string,
      body?: unknown,
      _headers?: Record<string, string>,
    ): Promise<AdaptorResponse> => {
      if (path === buildSignaturePath()) {
        signed.push(body as Record<string, unknown>);
        const status = options.signatureStatus ?? 200;
        return status === 200
          ? { status, body: { Success: 'Y', Signature: SIGNATURE } }
          : { status, body: { Success: 'N' } };
      }
      if (path === buildStatusPath()) {
        sent.push(body as Record<string, unknown>);
        return {
          status: options.statusStatus ?? 200,
          // `in` and not `??`: a fixture that IS null is a case under test, and
          // `null ?? fallback` would quietly answer the opposite one.
          body: 'statusBody' in options ? options.statusBody : LIVE_RESPONSE,
        };
      }
      throw new Error(`unexpected gateway path ${path} for ${method}`);
    },
  );

  return {
    store,
    transport,
    findExpectedChargeByTransactionId,
    signed,
    sent,
    service: new GatewayStatusService(store, transport),
  };
}

describe('asking the gateway what it thinks happened to a payment', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads the customer and the reason out of a live-shaped response', async () => {
    const { service } = harness();

    await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toEqual({
      customerReference: CUSTOMER,
      reasonCode: '12',
      responseCode: '12',
      reasonDescription: 'Invalid transaction',
      transactionIdentifier: '012072AB-756C-4D3e-85BF-EEF7A44D4969',
    });
  });

  it('declares FIVE fields of the twenty the live row carries', async () => {
    /*
      ★ THE NARROWING, ASSERTED RATHER THAN DESCRIBED.

      A type is not a runtime guarantee, so what proves the rest are dropped is
      that the object this service hands back does not carry them — by name, and
      whatever their values were. `transactionStatus` and `paymentStatus` are in
      that set for the reason the interface documents: nothing here asked about a
      payment OUTCOME, and reading one would widen the vocabulary this pipeline
      acts on.
    */
    const { service } = harness();

    const status = await service.lookup(ORGANIZATION_ID, TRANSACTION_ID);

    // The fixture's shape, pinned: 24 fields on the wire, five read.
    expect(DROPPED_FIELDS).toHaveLength(19);
    expect(Object.keys(status ?? {}).sort()).toEqual([
      'customerReference',
      'reasonCode',
      'reasonDescription',
      'responseCode',
      'transactionIdentifier',
    ]);
    for (const field of DROPPED_FIELDS) {
      expect(status).not.toHaveProperty(field);
    }
  });

  it('reads the ORGANIZATION-SCOPED intent before it will sign anything', async () => {
    const { service, findExpectedChargeByTransactionId } = harness();

    await service.lookup(ORGANIZATION_ID, TRANSACTION_ID);

    expect(findExpectedChargeByTransactionId).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      TRANSACTION_ID,
    );
  });

  it('signs the figure from OUR OWN SEALED RECORD and asks at the status path', async () => {
    /*
      ★ THE FIGURE IS NOT THE CALLBACK'S TO DECIDE.

      The gateway will not accept a status request without a signature, and the
      signature is computed over `Amount` and `CurrencyCode` — so both outbound
      bodies must carry the value that was stored with the intent, before either
      call leaves. A delivery carrying a different figure could not change them,
      and asserting the two bodies against each other is what shows the signature
      covers the request that carries it.
    */
    const { service, signed, sent } = harness({
      sealed: { [TRANSACTION_ID]: { amount: '250.00', currency: 'JMD' } },
    });

    await service.lookup(ORGANIZATION_ID, TRANSACTION_ID);

    expect(signed).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(signed[0]).toMatchObject({
      ClientId: expect.any(String),
      TransactionId: TRANSACTION_ID,
      CurrencyCode: 'JMD',
      Amount: '250.00',
      SignType: 1,
    });
    expect(sent[0]).toEqual({
      ClientId: expect.any(String),
      TransactionId: TRANSACTION_ID,
      CurrencyCode: 'JMD',
      Amount: '250.00',
      Signature: SIGNATURE,
    });
    // The same figure, verbatim, on both calls: ".00" is never re-derived.
    expect((sent[0] as { Amount: string }).Amount).toBe((signed[0] as { Amount: string }).Amount);
  });

  it('takes the figure from the row named by the TRANSACTION, not from the arguments', async () => {
    /*
      A second transaction with a different stored figure. There is no parameter
      a caller could use to state one — `lookup` takes an organization and an id
      and nothing else — so a different signed figure can only have come from the
      row that id named. That is what makes the sealed value load-bearing rather
      than decoration.
    */
    const { service, sent } = harness({
      sealed: {
        [TRANSACTION_ID]: { amount: '250.00', currency: 'JMD' },
        [OTHER_TRANSACTION_ID]: { amount: '99.99', currency: 'USD' },
      },
    });

    await service.lookup(ORGANIZATION_ID, OTHER_TRANSACTION_ID);

    expect(sent[0]).toMatchObject({ Amount: '99.99', CurrencyCode: 'USD' });
  });

  it('does not ask the gateway at all when we never recorded the payment', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { service, transport } = harness({ sealed: {} });

    await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toBeUndefined();

    // A signature needs a figure, and there is no figure to sign: a request that
    // asks the gateway to answer a question we cannot sign is not a request.
    expect(transport).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    // Identity only. The missing row's figure is not in the log because the row
    // has none.
    expect(warn.mock.calls[0]?.[0]).toEqual({ webhookId: TRANSACTION_ID });
  });

  describe('the flag', () => {
    it('accepts the LIVE capitalisation', async () => {
      const { service } = harness();

      await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toBeDefined();
    });

    it('accepts the DOCUMENTED lower-case spelling of a success', async () => {
      // The documentation's example reads `{"success": "Y", …}`. Refusing that
      // made every valid answer look like a refusal once already.
      const { service } = harness({
        statusBody: { ...LIVE_RESPONSE, Success: undefined, success: 'Y' },
      });

      await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toBeDefined();
    });

    it('still refuses anything that is not the STRING "Y"', async () => {
      // A JSON `true` is a plausible mistake against the documentation, and it
      // still reads as a refusal rather than as a success.
      const { service } = harness({
        statusBody: { ...LIVE_RESPONSE, Success: undefined, success: true },
      });

      await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toBeUndefined();
    });

    it('refuses a "N" answer', async () => {
      const { service } = harness({ statusBody: { Success: 'N', Results: [] } });

      await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toBeUndefined();
    });
  });

  describe('an answer that is not an answer', () => {
    it('treats an EMPTY Results array as "the gateway does not know"', async () => {
      // The key point is that it does not throw: this is a best-effort
      // enrichment, and `Results[0]` on a missing key would fail a delivery we
      // were only trying to learn something about.
      const { service } = harness({ statusBody: { Success: 'Y', Results: [] } });

      await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toBeUndefined();
    });

    it.each([
      ['no Results key at all', { Success: 'Y' }],
      ['a Results that is not an array', { Success: 'Y', Results: { CustomerReference: 'STU025' } }],
      ['a null row', { Success: 'Y', Results: [null] }],
      ['a body that is not an object', 'Y'],
      ['null', null],
    ])('treats %s as "unknown" rather than as a fault', async (_label, body) => {
      const { service } = harness({ statusBody: body });

      await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toBeUndefined();
    });

    it('refuses a customer reference that is not shaped like one', async () => {
      /*
        `MATCH_VALUE` is the rule the QuickBooks matcher enforces, and this value
        becomes that query parameter. A lookup arriving by a different door gets
        the same door's rules — a value this shape rejects is not a customer we
        could have named.
      */
      const { service } = harness({
        statusBody: {
          Success: 'Y',
          Results: [{ ...LIVE_RESPONSE.Results[0], CustomerReference: "STU' OR 1=1--" }],
        },
      });

      await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toMatchObject({
        customerReference: null,
      });
    });

    it('reads the LITERAL STRING "null" as absent, because the gateway sends it', async () => {
      const { service } = harness({
        statusBody: {
          Success: 'Y',
          Results: [{ ...LIVE_RESPONSE.Results[0], ReasonCode: 'null', ReasonCodeDesc: 'null' }],
        },
      });

      await expect(service.lookup(ORGANIZATION_ID, TRANSACTION_ID)).resolves.toMatchObject({
        reasonCode: null,
        reasonDescription: null,
      });
    });
  });

  it('reports an HTTP fault as a connection error quoting ONLY the status', async () => {
    /*
      ★ THE UPSTREAM'S OWN TEXT IS NOT REPEATED.

      The status-endpoint response carries a cardholder name, a padded card
      number, a billing email and a billing phone. This message reaches a failure
      tracker and a log file, so the status code is the whole of what is safe to
      say — asserted WHOLE, because "does not contain the email" is a weaker
      claim than "is exactly the sentence we wrote".
    */
    const { service } = harness({
      statusStatus: 502,
      statusBody: {
        Message: 'CardHolderName A Synthetic Nameholder declined for BillingEmail nobody@example.invalid',
      },
    });

    const err = await service.lookup(ORGANIZATION_ID, TRANSACTION_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdaptorConnectionError);
    expect((err as Error).message).toBe(
      'Amber Pay could not report the status of this transaction (status 502)',
    );
  });

  it('never logs the response it read', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
    const { service } = harness();

    await service.lookup(ORGANIZATION_ID, TRANSACTION_ID);

    for (const call of [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls, ...debug.mock.calls]) {
      expect(JSON.stringify(call)).not.toMatch(/CardHolderName|BillingEmail|BillingPhone|PaddedCardNo/);
    }
  });
});

describe('composing the gateway\'s reason into one sentence', () => {
  it('puts the code beside the description, preferring the reason code', () => {
    // A code alone is meaningless to whoever just had a payment declined, and a
    // description alone is the bare message the callback already gave. `12` and
    // `15` are deliberately different so the preference is visible.
    expect(
      gatewayFailureReason({
        customerReference: CUSTOMER,
        reasonCode: '12',
        responseCode: '15',
        reasonDescription: 'Invalid transaction',
        transactionIdentifier: null,
      }),
    ).toBe('12: Invalid transaction');
  });

  it('falls back to the response code when there is no reason code', () => {
    expect(
      gatewayFailureReason({
        customerReference: null,
        reasonCode: null,
        responseCode: '15',
        reasonDescription: 'Invalid transaction',
        transactionIdentifier: null,
      }),
    ).toBe('15: Invalid transaction');
  });

  it('is the bare description, or the bare code, when only one exists', () => {
    expect(
      gatewayFailureReason({
        customerReference: null,
        reasonCode: '12',
        responseCode: null,
        reasonDescription: null,
        transactionIdentifier: null,
      }),
    ).toBe('12');
    expect(
      gatewayFailureReason({
        customerReference: null,
        reasonCode: null,
        responseCode: null,
        reasonDescription: 'Invalid transaction',
        transactionIdentifier: null,
      }),
    ).toBe('Invalid transaction');
  });

  it('is null when the gateway explained nothing', () => {
    // The caller has to be able to tell "no reason" from "an empty reason", or a
    // customer would be told their payment failed with the reason "null".
    expect(
      gatewayFailureReason({
        customerReference: CUSTOMER,
        reasonCode: null,
        responseCode: null,
        reasonDescription: null,
        transactionIdentifier: null,
      }),
    ).toBeNull();
  });

  it('caps third-party text at the same length the callback reason is capped at', () => {
    const composed = gatewayFailureReason({
      customerReference: null,
      reasonCode: '12',
      responseCode: null,
      reasonDescription: 'x'.repeat(400),
      transactionIdentifier: null,
    });

    expect(composed).toHaveLength(200);
  });
});
