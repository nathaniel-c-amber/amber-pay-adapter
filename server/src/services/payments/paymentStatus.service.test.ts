import { PaymentStatusService } from './paymentStatus.service.js';
import { isStatusToken, sealExpectedCharge } from '../gateway/amberPayWire.js';
import { ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import type { CheckoutStatusRow, PaymentStatusStore } from './paymentStatus.service.js';

/*
  THE ONLY READ IN THE SERVER WITH NO SESSION, AND IT IS WHY THIS FILE IS SHARP.

  Whoever calls `lookup` is a customer who has just handed over a card: no
  session, no uuid, no operator's credentials. A 256-bit token in the url is the
  whole authorisation, so every branch below is a sentence about somebody's money
  being read out by whoever holds that token — and the assertions are written
  against the production comments that state WHY each branch is what it is,
  because those comments are the specification.
*/

/**
 * A token of the exact shape we mint: 43 base64url characters.
 *
 * A FIXED literal rather than `generateStatusToken()`, so a failure names the
 * same token every time. It carries `-` and `_` on purpose — the two characters
 * base64 chose over `+` and `/` because those have to be percent-encoded to
 * survive a url, a fragment and a copy-paste.
 */
const TOKEN = 'nT9-qR2wYbX7cV1mL4dH6fG0sA8uE3iO5nP7qRjzKc1';

/** The gateway's own echo of our id — what a customer quotes at support. */
const TRANSACTION_ID = 'E09KUZXK6BZJ';

/**
 * The one collaborator: a row, or the absence of one.
 *
 * `tokens` records what the service ASKED for, which is the only way to assert
 * that a malformed token is refused before it becomes an equality probe against
 * a unique index, and that a lookup reads exactly one row.
 */
function storeReturning(row: CheckoutStatusRow | undefined) {
  const tokens: string[] = [];
  const store: PaymentStatusStore = {
    async findByStatusToken(token: string) {
      tokens.push(token);
      return row;
    },
  };
  return { store, tokens };
}

/** A stored intent as the status read finds it. Every field is overridable. */
function storedIntent(overrides: Partial<CheckoutStatusRow> = {}): CheckoutStatusRow {
  return {
    transactionId: TRANSACTION_ID,
    expectedSealed: sealExpectedCharge('250.00', 'JMD'),
    outcome: null,
    failureReason: null,
    ...overrides,
  };
}

describe('PaymentStatusService.lookup', () => {
  it('reports a collected payment, and NEVER attaches a reason to it', async () => {
    /*
      ★ THE GUARD AT THE HEART OF THE VIEW.

      "Only ever shown alongside a failure. A success carrying a stale reason
      would read as the gateway's verdict on a payment that actually cleared."

      So the row here is deliberately inconsistent — `collected` WITH a
      `failureReason` left on it — and the assertion is that the reason does not
      survive. Reading it as returned would tell a customer their card was
      declined on a payment that went through, and the page is the only thing
      they will ever see to decide what to do next.
    */
    const { store } = storeReturning(
      storedIntent({ outcome: 'collected', failureReason: 'Invalid transaction' }),
    );

    const view = await new PaymentStatusService(store).lookup(TOKEN);

    expect(view).toEqual({
      status: 'collected',
      reference: TRANSACTION_ID,
      reason: null,
      amount: '250.00',
      currency: 'JMD',
    });
  });

  it('reports a failure with the gateway\'s own words, verbatim', async () => {
    /*
      "The gateway's own failure text, verbatim-ish ... This is the USER'S OWN
      WORDS COMING BACK TO THEM ... a decline reason from an issuer, quoted so
      the page can say why rather than shrug."

      Verbatim, because the sanitising and capping happened in the gateway layer
      where the wire is faced; a second pass here would be a second thing to
      keep honest, and the only field a customer can act on is this one.
    */
    const { store } = storeReturning(
      storedIntent({ outcome: 'failed', failureReason: 'Invalid transaction' }),
    );

    const view = await new PaymentStatusService(store).lookup(TOKEN);

    expect(view).toMatchObject({
      status: 'failed',
      reason: 'Invalid transaction',
    });
    // The reference is quoted at support, so it is there on the failure path too.
    expect(view.reference).toBe(TRANSACTION_ID);
  });

  it('reports an in-flight payment as pending, with no reason', async () => {
    /*
      "`pending` ... will mean 'the gateway says this payment is still in flight'
      once the status-API follow-up lands."  Nothing has been decided yet, so
      there is nothing to explain to the customer.
    */
    const { store } = storeReturning(storedIntent({ outcome: 'pending' }));

    const view = await new PaymentStatusService(store).lookup(TOKEN);

    expect(view).toMatchObject({ status: 'pending', reason: null });
  });

  it('reports a payment with no verdict as `unknown` rather than throwing', async () => {
    /*
      ★ THE NORMAL STATE FOR SOMEONE WHO HAS JUST PAID.

      "`unknown` is the absence of a verdict, not a verdict: the token resolved
      (or did not) but the gateway's callback has not been processed yet."  The
      token resolved here, so the row is found and the figure still opens — only
      the verdict is absent. What the customer must not get here is an error
      page: their money is fine and the gateway is simply late.
    */
    const { store } = storeReturning(storedIntent({ outcome: null }));

    const view = await new PaymentStatusService(store).lookup(TOKEN);

    expect(view).toEqual({
      status: 'unknown',
      // The reference IS available even with no verdict: a customer who needs to
      // chase this needs something to quote, and the token they hold proves the
      // payment is theirs.
      reference: TRANSACTION_ID,
      reason: null,
      amount: '250.00',
      currency: 'JMD',
    });
  });

  it('answers `unknown` and four nulls for a well-formed token that names nothing', async () => {
    /*
      ★ NO 404, DELIBERATELY.

      "The store filters on the expiry itself, so an expired token arrives here
      as 'no row' and is reported as `unknown` rather than as an error."  At 256
      bits there is nothing to enumerate, so a 404 would buy no security while
      it WOULD tell the SPA to render an error page for the one case that is
      entirely normal.

      Asserted as the WHOLE object, not the status: a partially-populated view
      here (a reference with no verdict, a figure with no status) is exactly the
      "empty result with no way to tell it from a payment still processing" the
      sibling fallback in `webhooks.controller.ts` refuses to redirect into.
    */
    const { store, tokens } = storeReturning(undefined);

    const view = await new PaymentStatusService(store).lookup(TOKEN);

    expect(view).toEqual({
      status: 'unknown',
      reference: null,
      reason: null,
      amount: null,
      currency: null,
    });
    // One indexed equality probe, and it is the only thing that happened.
    expect(tokens).toEqual([TOKEN]);
  });

  it('refuses a token that is not the SHAPE of one we mint, before it reaches the database', async () => {
    /*
      "A token that is not the SHAPE of one we mint is refused with a 400 ... a
      malformed token is a client's bug worth telling it about" — and it is
      refused HERE rather than by the query, because the exact length and
      alphabet belong with the code that mints tokens.

      The fixture is asserted first so these refusals are about the malformed
      values rather than about a constant that has drifted out of shape.
    */
    expect(isStatusToken(TOKEN)).toBe(true);
    const malformed = [
      'not-a-status-token',
      // Right alphabet, one character short of the derived length.
      TOKEN.slice(0, 42),
      // Right length, base64 rather than base64url: a padded value is a value
      // that has been through a codec that does not know this token's rules.
      `${'a'.repeat(42)}=`,
    ];

    for (const token of malformed) {
      const { store, tokens } = storeReturning(storedIntent({ outcome: 'collected' }));
      await expect(new PaymentStatusService(store).lookup(token)).rejects.toThrow(ValidationError);
      // Never handed to the database: not as an equality probe against the
      // unique index, and not at all.
      expect(tokens).toEqual([]);
    }
  });

  it('opens the sealed figure as the operator typed it — a string, never a number', async () => {
    /*
      ★ "MAJOR units, as the string the operator typed. NEVER a JS number."

      `DECIMAL_AMOUNT` says why in full: `Number("250.00")` is `250`, so a
      numeric field would quietly drop the decimals, and a figure recorded as one
      value and shown as another is the exact failure the gateway signature
      exists to prevent. The view is allow-listed in `models/privacy.test.ts` to
      carry this pair and nothing else.
    */
    const { store } = storeReturning(
      storedIntent({
        outcome: 'collected',
        expectedSealed: sealExpectedCharge('250.00', 'JMD'),
      }),
    );

    const view = await new PaymentStatusService(store).lookup(TOKEN);

    expect(view.amount).toBe('250.00');
    expect(view.currency).toBe('JMD');
    expect(typeof view.amount).toBe('string');
    expect(typeof view.currency).toBe('string');
  });

  it('keeps the decimals a number would have thrown away', async () => {
    /*
      The canary, on the exact example `DECIMAL_AMOUNT` uses: `Number("250.00")`
      is `250`. So the assertion is not merely that the view holds a string — it
      is that the figure it holds is one a JS number CANNOT represent, which is
      what makes "never a number" a rule rather than a style preference. A
      coercion anywhere between the cipher and this page would show the customer
      a different amount from the one that was recorded and signed.
    */
    const { store } = storeReturning(
      storedIntent({
        outcome: 'collected',
        expectedSealed: sealExpectedCharge('250.00', 'JMD'),
      }),
    );

    const view = await new PaymentStatusService(store).lookup(TOKEN);

    expect(view.amount).toBe('250.00');
    // Proof that the loss is real for THIS figure, so the assertion above is
    // about the value rather than about the type it happens to arrive as.
    expect(String(Number(view.amount))).toBe('250');
    expect(String(Number(view.amount))).not.toBe(view.amount);
  });

  it('degrades to a missing figure rather than failing the whole page', async () => {
    /*
      ★ A FAILURE HERE IS NOT PROPAGATED, AND THAT IS THE POINT.

      "If the deployment's encryption key is missing, every customer would see an
      error page about a payment that went through perfectly well — trading a
      correct, slightly less informative answer for a wrong and alarming one. Null
      figures render as 'not available', which is true."

      So the key is REMOVED under the service and the verdict still comes back.
      The figure is decoration on a page whose real content is the verdict, and a
      degraded page is a page somebody can still act on.
    */
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    // Sealed while the key is still configured — an operator who lost the key
    // lost it after checkout, which is the case that must degrade.
    const sealed = sealExpectedCharge('250.00', 'JMD');
    const { store } = storeReturning(storedIntent({ outcome: 'collected', expectedSealed: sealed }));

    const original = env.SECRETS_KEY;
    env.SECRETS_KEY = undefined;
    let view;
    try {
      view = await new PaymentStatusService(store).lookup(TOKEN);
    } finally {
      env.SECRETS_KEY = original;
    }

    expect(view).toEqual({
      status: 'collected',
      reference: TRANSACTION_ID,
      reason: null,
      amount: null,
      currency: null,
    });
    // It is a WARN and not silence: a deployment with no key shows every customer
    // "not available", and the only trace of why is this line.
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Stored payment figure could not be opened'),
    );
  });
});
