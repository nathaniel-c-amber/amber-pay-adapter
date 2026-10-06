import { CheckoutService, DuplicateTransactionIdError } from './checkout.service.js';
import { AdaptorError } from '../adaptors/errors.js';
import { openExpectedCharge } from './amberPayWire.js';
import type { CheckoutIntentStore } from './checkout.service.js';
import type { AdaptorResponse, HttpMethod } from '../../types/adaptor.js';

/**
 * A store that records the ORDER of what happened.
 *
 * The ordering guarantee in `create` — persist BEFORE signing — is the single
 * most important property of this service, and it is invisible to a test that
 * only inspects the result. So the store and the transport both push onto one
 * shared log, and the test reads the sequence.
 */
function harness(options: {
  takenIds?: string[];
  signature?: { status: number; body: unknown };
  transportError?: Error;
} = {}) {
  const order: string[] = [];
  const stored: {
    organizationId: string;
    transactionId: string;
    studentId: string;
    expectedSealed: Buffer;
  }[] = [];

  const intents: CheckoutIntentStore = {
    async create(input) {
      if (options.takenIds?.includes(input.transactionId)) {
        order.push('store:rejected');
        throw new DuplicateTransactionIdError(input.transactionId);
      }
      order.push(`store:write:${input.transactionId}`);
      stored.push(input as never);
    },
    async findByTransactionId() {
      return undefined;
    },
  };

  const transport = jest.fn(
    async (
      _method: HttpMethod,
      url: string,
      _body?: unknown,
      _headers?: Record<string, string>,
    ): Promise<AdaptorResponse> => {
      if (options.transportError) throw options.transportError;
      order.push(`gateway:${url.split('/').pop()}`);
      return options.signature ?? { status: 200, body: { success: 'Y', Signature: 'c2ln' } };
    },
  );

  return { intents, transport, order, stored };
}

const input = {
  organizationId: 'default',
  studentId: 'STU0026',
  amountMinorUnits: 25000,
  currency: 'JMD' as const,
  clientId: 'quick_book_stage',
};

describe('creating a checkout', () => {
  it('records the intent BEFORE asking the gateway to sign it', async () => {
    /*
      ★ THE ORDERING GUARANTEE.

      The gateway echoes our transaction id back on the callback, and that echo is
      the only link between an incoming payment and our record. Signing first and
      storing second means a crash in between leaves a signature for an id we
      never recorded — and a customer could then complete a payment we cannot
      attribute.

      The failure mode of the correct order is the harmless one: an intent with no
      completed payment is an abandoned checkout.
    */
    const { intents, transport, order } = harness();
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');

    await service.create(input);

    expect(order).toEqual([
      'store:write:ABCDEFGH1234',
      'gateway:generatesignature',
    ]);
  });

  it('never calls the gateway when the intent cannot be stored', async () => {
    // A validation failure, a missing key, an outage — all must surface at once
    // rather than retrying into three identical failures.
    const transport = jest.fn();
    const service = new CheckoutService(
      {
        async create() {
          throw new Error('database is down');
        },
        async findByTransactionId() {
          return undefined;
        },
      },
      transport,
      () => 'ABCDEFGH1234',
    );

    await expect(service.create(input)).rejects.toThrow('database is down');
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns the parameters the browser posts, and a destination it leaves our origin for', async () => {
    const { intents, transport } = harness();
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');

    const session = await service.create(input);

    expect(session.transactionId).toBe('ABCDEFGH1234');
    // Absolute, and on the gateway's host: the customer's card details go to
    // Amber, not through us. A relative URL would make us a party to the card
    // path, which is the one thing this design exists to avoid.
    expect(session.checkoutUrl).toMatch(/^https?:\/\/.+\/gateway\/v1\/standard-checkout$/);
    expect(session.params).toMatchObject({
      ClientId: 'quick_book_stage',
      TransactionId: 'ABCDEFGH1234',
      CurrencyCode: 'JMD',
      Amount: 25000,
      Signature: 'c2ln',
      CustomerReference: 'STU0026',
    });
    // We render the receipt, so the gateway is not asked to email one — and this
    // deployment deliberately holds no billing addresses to email it to.
    expect(session.params.CustomerInvoice).toBe('N');
  });

  it('carries the customer as CustomerReference, which is what comes back', async () => {
    const { intents, transport } = harness();
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');
    const session = await service.create(input);
    // The callback's StudentID is what attributes a payment, so the checkout
    // must send the same value under the parameter the gateway echoes.
    expect(session.params.CustomerReference).toBe('STU0026');
  });
});

describe('the id is never reused', () => {
  it('generates a fresh one when the store says the first is taken', async () => {
    const { intents, transport, stored } = harness({ takenIds: ['AAAAAAAAAAAA'] });
    let draw = 0;
    const service = new CheckoutService(intents, transport, () => {
      draw += 1;
      return draw === 1 ? 'AAAAAAAAAAAA' : 'BBBBBBBBBBBB';
    });

    const session = await service.create(input);

    expect(session.transactionId).toBe('BBBBBBBBBBBB');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.transactionId).toBe('BBBBBBBBBBBB');
  });

  it('gives up rather than looping forever when every id is taken', async () => {
    const { intents, transport } = harness({ takenIds: ['AAAAAAAAAAAA'] });
    const service = new CheckoutService(intents, transport, () => 'AAAAAAAAAAAA');

    // A store that rejects everything must not spin. Three attempts, then out.
    await expect(service.create(input)).rejects.toThrow(DuplicateTransactionIdError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a generator that returns the wrong shape, before storing anything', async () => {
    const { intents, transport } = harness();
    const service = new CheckoutService(intents, transport, () => 'too-short');

    // A broken generator would otherwise produce ids the gateway rejects at
    // checkout — after we had already recorded an intent for one.
    await expect(service.create(input)).rejects.toThrow(/did not produce a valid identifier/);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('reading the signature', () => {
  it('refuses a non-2xx answer', async () => {
    const { intents, transport } = harness({ signature: { status: 500, body: {} } });
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');
    await expect(service.create(input)).rejects.toThrow(AdaptorError);
  });

  it('refuses success:"N" rather than signing with an absent signature', async () => {
    const { intents, transport } = harness({
      signature: { status: 200, body: { success: 'N' } },
    });
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');
    await expect(service.create(input)).rejects.toThrow(/declined to sign/);
  });

  it('refuses a JSON boolean where the gateway sends the string "Y"', async () => {
    /*
      `success` is the STRING "Y". A boolean `true` here is a plausible mistake
      — and it fails the check, so a valid request would look refused.
    */
    const { intents, transport } = harness({
      signature: { status: 200, body: { success: true, Signature: 'c2ln' } },
    });
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');
    await expect(service.create(input)).rejects.toThrow(/declined to sign/);
  });

  it('refuses an empty signature', async () => {
    const { intents, transport } = harness({
      signature: { status: 200, body: { success: 'Y', Signature: '   ' } },
    });
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');
    await expect(service.create(input)).rejects.toThrow(/empty signature/);
  });

  it('does not repeat the gateway upstream text, which can quote the amount', async () => {
    const { intents, transport } = harness({
      signature: {
        status: 200,
        body: { success: 'N', ErrorMessage: 'Amount 25000 is not permitted for this ClientId' },
      },
    });
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');
    // The message can name the figure, and it can reach a log line.
    await expect(service.create(input)).rejects.toThrow(/^(?!.*25000).*$/s);
  });
});

describe('what is stored', () => {
  it('seals the figure and its currency rather than writing either plainly', async () => {
    const { intents, transport, stored } = harness();
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');

    await service.create(input);

    expect(openExpectedCharge(stored[0]!.expectedSealed)).toEqual({
      amountMinorUnits: 25000,
      currency: 'JMD',
    });
    expect(stored[0]!.expectedSealed.includes('25000')).toBe(false);
  });

  it('stores the customer in the clear, because the callback is resolved through it', async () => {
    const { intents, transport, stored } = harness();
    const service = new CheckoutService(intents, transport, () => 'ABCDEFGH1234');

    await service.create(input);

    // student_id is the join key; it is an opaque identifier, deliberately NOT
    // the customer's name.
    expect(stored[0]).toMatchObject({ studentId: 'STU0026' });
  });
});