import { createHmac } from 'node:crypto';
import { AmberPayGatewayImpl } from './amberpay.service.js';
import { ValidationError } from '../../utils/errors.js';

const SECRET = 'test-webhook-secret-placeholder';

/**
 * Amber Pay's wire payload, in the SHAPE A REAL CALLBACK ARRIVES (supplied
 * 2026-10-06). Every earlier fixture in this file was invented here, which is
 * precisely why it could not catch the identity bug below: a payload this
 * repository writes will always agree with this repository's mistakes.
 *
 * The three ids are deliberately different values, because that is the whole
 * point — conflating them is what the old fixture invited.
 */
const payload = {
  ClientId: 'quick_book_stage',
  TransactionDate: '2026-09-28T15: 58: 15Z',
  TransactionId: 'WKjMPE0MR0u3',
  OrderId: '17906110924250WKjMPE0MR0u3',
  StudentID: 'STU0026',
  PaymentStatus: 'Success',
};

/**
 * A real callback response, verbatim, including the PII the schema must drop.
 *
 * Reproduced rather than trimmed so the privacy assertion below is testing the
 * fields that genuinely arrive — the narrow schema only became necessary
 * BECAUSE they are on the wire.
 */
const REAL_CALLBACK = {
  ClientId: 'quick_book_stage',
  TransactionDate: '2026-09-28T15: 58: 15Z',
  TransactionId: 'WKjMPE0MR0u3',
  OrderId: '17906110924250WKjMPE0MR0u3',
  AmountCharged: 25000,
  PaymentStatus: 'Success',
  TransactionStatus: 'Success',
  InvoiceId: '',
  WixTransactionId: '',
  ProcessSignature: '',
  CurrencyCode: 'JMD',
  ReasonCode: '00',
  ReasonCodeDesc: 'Transaction is approved',
  ResponseCode: '00',
  CardHolderName: 'Test User',
  CardType: 'VISA',
  PaddedCardNo: '4012XXXXXXXX0071',
  AuthCode: '123456',
  BillingEmail: 'test@email.com',
  BillingPhone: '8761234567',
  ReprocessFlag: 'N',
  BillingName: null,
  OriginalReasonDesc: '',
  CustomerReference: null,
  CardToken: '',
  CardExpiry: '',
  CustomMessage: null,
  GeneratedUserMailId: '',
  ErrorCode: '',
  ErrorMessage: '',
  StudentID: 'STU0026',
} as const;

const rawBody = JSON.stringify(payload);

function sign(value: string): string {
  return createHmac('sha256', SECRET).update(value).digest('hex');
}

describe('AmberPayGatewayImpl', () => {
  it('verifyWebhookSignature returns true for a valid signature', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.verifyWebhookSignature(rawBody, sign(rawBody))).toBe(true);
  });

  it('verifyWebhookSignature returns false for an invalid signature', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.verifyWebhookSignature(rawBody, 'invalid')).toBe(false);
  });

  it('verifyWebhookSignature accepts a Buffer raw body', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.verifyWebhookSignature(Buffer.from(rawBody), sign(rawBody))).toBe(true);
  });

  it('parseWebhook maps a Success payload to a collected event', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.parseWebhook(payload)).toEqual({
      id: 'WKjMPE0MR0u3',
      type: 'payment.collected',
      reference: 'STU0026',
      status: 'collected',
      // The gateway's own time, normalized. `15: 58: 15Z` with the spaces.
      at: '2026-09-28T15:58:15.000Z',
    });
  });

  /*
    ★ THE REGRESSION THIS WHOLE CHANGE EXISTS FOR.

    `reference` is the match value: it flows into `PaymentRef.matchValue` and
    then into the accounting customer's name. It was `OrderId`, which a real
    callback shows as `17906110924250WKjMPE0MR0u3` — a timestamp the gateway
    generated with our own TransactionId appended. So the matcher had been
    searching for a timestamp-plus-random string that no customer could ever be
    named, and every payment failed to match.

    The old fixture used the same value for `TransactionId` and `OrderId`, so it
    could not tell the two apart even in principle. These are different values,
    and the assertion is specifically that the CUSTOMER came through.
  */
  it('parses the real callback, and identifies the customer and not the order', () => {
    const gateway = new AmberPayGatewayImpl();
    const event = gateway.parseWebhook(REAL_CALLBACK);

    expect(event.id).toBe('WKjMPE0MR0u3'); // OURS — the dedup key
    expect(event.reference).toBe('STU0026'); // the CUSTOMER — the match value
    expect(event.reference).not.toContain('17906110924250');
    expect(event.reference).not.toBe(REAL_CALLBACK.OrderId);
    expect(event.status).toBe('collected');
  });

  it('drops every PII and financial field the real callback actually carries', () => {
    const gateway = new AmberPayGatewayImpl();
    const event = gateway.parseWebhook(REAL_CALLBACK);

    // No amount, no currency, no card, no name, no contact details.
    const serialised = JSON.stringify(event);
    for (const forbidden of [
      '25000',
      'JMD',
      'Test User',
      '4012XXXXXXXX0071',
      '123456',
      'test@email.com',
      '8761234567',
      'VISA',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
    // And on the keys, so a rename cannot smuggle one back in.
    expect(Object.keys(event).sort()).toEqual(['at', 'id', 'reference', 'status', 'type']);
  });

  it('reads the event time despite the spaces the gateway writes', () => {
    /*
      `"2026-09-28T15: 58: 15Z"` is not valid ISO-8601 — there are spaces after
      the time separators — so `z.string().datetime()` rejects it. Validating the
      field strictly would reject every real callback; the old `EventTimestamp`
      name never matched anything, which is why this never surfaced.
    */
    const gateway = new AmberPayGatewayImpl();
    const event = gateway.parseWebhook(payload);
    expect(new Date(event.at).getTime()).toBe(Date.parse('2026-09-28T15:58:15Z'));
  });

  it('falls back to arrival time when the gateway omits the time', () => {
    const gateway = new AmberPayGatewayImpl();
    const { TransactionDate: _omitted, ...withoutTime } = payload;
    const event = gateway.parseWebhook(withoutTime);
    expect(Number.isNaN(new Date(event.at).getTime())).toBe(false);
  });

  it('falls back to arrival time rather than trusting an unreadable one', () => {
    const gateway = new AmberPayGatewayImpl();
    const event = gateway.parseWebhook({ ...payload, TransactionDate: 'not-a-date' });
    // A wrong timestamp is worse than a late one, so an unparseable value is
    // discarded rather than propagated.
    expect(Number.isNaN(new Date(event.at).getTime())).toBe(false);
    expect(event.at).not.toContain('not-a-date');
  });

  it('parseWebhook maps Failed to its own type', () => {
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.parseWebhook({ ...payload, PaymentStatus: 'Failed' })).toMatchObject({
      type: 'payment.failed',
      status: 'failed',
    });
  });

  /*
    `Refunded` is NOT a callback status, and neither are `Canceled` or
    `Pending`. The first is an API call plus a terminal state; the other two come
    from the status API. Accepting them here would mean mapping a payload onto a
    state it does not report — so each is refused, loudly.
  */
  it.each(['Refunded', 'Canceled', 'Pending'])(
    'refuses the non-callback status %s rather than guessing at it',
    (status) => {
      const gateway = new AmberPayGatewayImpl();
      expect(() => gateway.parseWebhook({ ...payload, PaymentStatus: status })).toThrow(
        ValidationError,
      );
    },
  );

  it('carries no StudentID as a null reference rather than failing the payload', () => {
    /*
      The money arrived; only the attribution is missing. Rejecting would lose a
      real payment and retry it forever, and inventing a subject would risk
      matching the wrong customer. The processor refuses the push with a reason.
    */
    const gateway = new AmberPayGatewayImpl();
    const { StudentID: _omitted, ...withoutStudent } = payload;
    expect(gateway.parseWebhook(withoutStudent)).toMatchObject({
      id: 'WKjMPE0MR0u3',
      reference: null,
    });
  });

  it('rejects a StudentID that is not an opaque identifier', () => {
    const gateway = new AmberPayGatewayImpl();
    // The canonical failure: an email address must never reach the event log.
    expect(() =>
      gateway.parseWebhook({ ...payload, StudentID: 'customer@example.com' }),
    ).toThrow(ValidationError);
    expect(() => gateway.parseWebhook({ ...payload, StudentID: 'ab' })).toThrow(ValidationError);
  });

  it('accepts a seven-character StudentID, which the transaction floor rejects', () => {
    /*
      `STU0026` is seven characters. `OPAQUE_REFERENCE` demands eight — so a
      real customer identifier would have failed every callback at the parser.
      `MATCH_VALUE` lowers the FLOOR only; the character set is unchanged, which
      is what keeps the value safe to interpolate into a query.
    */
    const gateway = new AmberPayGatewayImpl();
    expect(gateway.parseWebhook({ ...payload, StudentID: 'STU0026' }).reference).toBe('STU0026');
  });

  it('createPaymentLink returns a PaymentLinkResult shape', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    const gateway = new AmberPayGatewayImpl(transport);
    const result = await gateway.createPaymentLink({
      invoiceId: 'inv-1',
      externalInvoiceId: 'ext-1',
      reference: 'ref-0001',
      status: 'initiated',
    });
    expect(typeof result.linkUrl).toBe('string');
    expect(typeof result.reference).toBe('string');
    expect(typeof result.expiresAt).toBe('string');
  });
});
