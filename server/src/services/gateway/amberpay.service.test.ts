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
      // Present as an explicit null, never absent: a success with no reason is a
      // fact the processor can read, and an optional field would make it
      // indistinguishable from a gateway that has not been asked yet.
      failureReason: null,
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
    //
    // `failureReason` is the one addition, and it is here deliberately rather
    // than left to the reader: it is the gateway's OWN TEXT about the
    // transaction, shown back to the customer whose transaction it was, and it
    // is null for a Success — so the amount, the currency and every card field
    // above are still absent from this object and from its serialisation. The
    // list below is the allow-list, and it is enumerated so a sixth key has to
    // be added by hand.
    expect(Object.keys(event).sort()).toEqual([
      'at',
      'failureReason',
      'id',
      'reference',
      'status',
      'type',
    ]);
  });

  it('carries the gateway\'s own failure text, and nothing from the wire beside it', () => {
    const gateway = new AmberPayGatewayImpl();

    // The REAL failed callback (2026-10-16), verbatim: three message keys, two
    // of them the same value, one of them a misspelling of the other's name.
    const failed = gateway.parseWebhook({
      ClientId: 'quick_book_stage',
      TransactionId: 'E09KUZXK6BZJ',
      OrderId: '17921677369780E09KUZXK6BZJ',
      PaymentStatus: 'Failed',
      Amount: '25000',
      CurrencyCode: 'JMD',
      ResponseMsg: 'Invalid transaction',
      ReponseMsg: 'Invalid transaction',
      ErrorCode: '',
      ErrorMessage: 'Invalid transaction',
      PaddedCardNo: '4012XXXXXXX0071',
    });

    // `ErrorMessage` is the primary, and the text is what a customer page needs:
    // "failed" alone is equally true of an expired card and a typo.
    expect(failed.failureReason).toBe('Invalid transaction');
    // The figure and the card-adjacent fields beside it are still dropped. The
    // reason is text; the amount is money and the padded number is an
    // instrument, and neither may ride along on a new field.
    expect(JSON.stringify(failed)).not.toContain('25000');
    expect(JSON.stringify(failed)).not.toContain('4012');
  });

  it('falls back to the other message keys, because the gateway sends all three and promises none', () => {
    const gateway = new AmberPayGatewayImpl();
    const base = {
      ClientId: 'quick_book_stage',
      TransactionId: 'E09KUZXK6BZJ',
      OrderId: '17921677369780E09KUZXK6BZJ',
      PaymentStatus: 'Failed',
    };

    // Only the correctly-spelled secondary key.
    expect(gateway.parseWebhook({ ...base, ResponseMsg: 'Card declined' }).failureReason).toBe(
      'Card declined',
    );
    // ONLY the misspelling — which is a real shape today, and a delivery that
    // arrived this way used to have nothing at all to say.
    expect(gateway.parseWebhook({ ...base, ReponseMsg: 'Card declined' }).failureReason).toBe(
      'Card declined',
    );
    // Neither, and no ErrorMessage: a decline with no words attached is a real
    // state, and it must be `null` rather than the string "undefined".
    expect(gateway.parseWebhook(base).failureReason).toBeNull();
  });

  it('reads a message that says it means "no value" as ABSENT, not as the word', () => {
    const gateway = new AmberPayGatewayImpl();
    const base = {
      ClientId: 'quick_book_stage',
      TransactionId: 'E09KUZXK6BZJ',
      OrderId: '17921677369780E09KUZXK6BZJ',
      PaymentStatus: 'Failed',
    };

    // The observed callback sends `StoreVerifyFlag=null` and `CustomMessage=null`
    // as the STRING "null". A naive read shows a customer the word "null" as the
    // reason their payment was declined — which is worse than saying nothing.
    expect(gateway.parseWebhook({ ...base, ErrorMessage: 'null', ResponseMsg: 'null' }).failureReason)
      .toBeNull();
    expect(gateway.parseWebhook({ ...base, ErrorMessage: '   ' }).failureReason).toBeNull();
    // …and when the misspelled key is the one carrying the value.
    expect(gateway.parseWebhook({ ...base, ErrorMessage: 'null', ReponseMsg: 'Invalid transaction' })
      .failureReason).toBe('Invalid transaction');
  });

  it('never leaves a reason on a payment that succeeded', () => {
    const gateway = new AmberPayGatewayImpl();
    const event = gateway.parseWebhook({ ...REAL_CALLBACK, PaymentStatus: 'Success' });

    // A Success that still carried a reason would read as the gateway's verdict
    // on a payment that actually cleared — so the text is read ONLY on a
    // failure, whatever the rest of the payload says.
    expect(event.failureReason).toBeNull();
  });

  it('strips control characters, collapses whitespace and caps the length', () => {
    const gateway = new AmberPayGatewayImpl();
    const hostile =
      'Invalid transaction\r\n  for  reason  code  E42\\x3c/script>';

    const event = gateway.parseWebhook({
      ClientId: 'quick_book_stage',
      TransactionId: 'E09KUZXK6BZJ',
      OrderId: '17921677369780E09KUZXK6BZJ',
      PaymentStatus: 'Failed',
      ErrorMessage: hostile,
    });

    // Nothing that can end a line or a terminal escape survives: this text is
    // rendered in a browser tab from a body a third party form-encodes.
    expect(event.failureReason).toBe('Invalid transaction for reason code E42\\x3c/script>');
    expect(event.failureReason).not.toMatch(/[\u0000-\u001f\u007f]/);

    // Capped, because this is unbounded third-party text going into a column.
    const long = gateway.parseWebhook({
      ClientId: 'quick_book_stage',
      TransactionId: 'E09KUZXK6BZJ',
      OrderId: '17921677369780E09KUZXK6BZJ',
      PaymentStatus: 'Failed',
      ErrorMessage: 'x'.repeat(5000),
    });
    expect(long.failureReason).toHaveLength(200);
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
