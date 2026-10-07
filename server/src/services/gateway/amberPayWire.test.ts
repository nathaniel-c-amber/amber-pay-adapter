import {
  generateTransactionId,
  isTransactionId,
  openExpectedCharge,
  sealExpectedCharge,
  TRANSACTION_ID_LENGTH,
  STUDENT_ID,
} from './amberPayWire.js';
import { sealSecret } from '../../utils/secrets.js';
import { ValidationError } from '../../utils/errors.js';

describe('the transaction id we issue', () => {
  it('is the length the gateway documents', () => {
    // The doc says 8-12 and a real callback echoed 12, so 12 is the ceiling.
    // Its own suggested recipe (YYYYMMDDHHMMSS + digits) is 16-18 and would be
    // rejected — which is why that recipe is deliberately not followed.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(generateTransactionId()).toHaveLength(TRANSACTION_ID_LENGTH);
    }
  });

  it('passes its own shape check, so a generated id is never refused downstream', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(isTransactionId(generateTransactionId())).toBe(true);
    }
  });

  it('is drawn only from the alphabet the callback can echo safely', () => {
    // Alphanumeric only: no punctuation that could confuse a delimiter, and no
    // character that would need escaping anywhere it is compared.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      expect(generateTransactionId()).toMatch(/^[A-Z0-9]+$/);
    }
  });

  it('does not repeat in five hundred draws', () => {
    /*
      The generator's job is to make a collision RARE, not impossible — the
      UNIQUE index is what makes it impossible. But 500 draws over a 36^12 space
      colliding would mean the generator is not doing its part, so it is worth
      asserting the cheap property directly.
    */
    const seen = new Set(Array.from({ length: 500 }, () => generateTransactionId()));
    expect(seen.size).toBe(500);
  });

  it('is not derived from the clock', () => {
    // Two ids drawn back to back must not share a timestamp-shaped prefix.
    const a = generateTransactionId();
    const b = generateTransactionId();
    expect(a.slice(0, 6)).not.toBe(b.slice(0, 6));
  });

  it('refuses a value that is not the shape we issue', () => {
    // Seven characters is one short of the documented floor. (`TOOSHORT` is
    // eight, and therefore VALID — a reminder that the check is on shape, not on
    // what a string happens to spell.)
    expect(isTransactionId('TOOSHORT')).toBe(true);
    expect(isTransactionId('SHORTEN')).toBe(false);
    expect(isTransactionId('HAS-A-DASH-IN-IT')).toBe(false);
    expect(isTransactionId('lowercase12345')).toBe(false);
    expect(isTransactionId('A'.repeat(13))).toBe(false);
    expect(isTransactionId('')).toBe(false);
  });
});

describe('the customer identifier', () => {
  it('accepts a real seven-character identifier', () => {
    // `STU0026` is the actual value from a live callback. An 8+ floor rejects it,
    // which would have failed every real callback at the parser.
    expect(STUDENT_ID.test('STU0026')).toBe(true);
  });

  it('refuses anything that could escape into a query', () => {
    /*
      The character set is the whole protection, and it is unchanged — only the
      length floor moved. These are the cases that must never pass.
    */
    for (const unsafe of [
      "STU0026' OR '1'='1",
      "STU0026'; DROP TABLE Customer;--",
      'STU 0026',
      'STU0026$',
      'STU0026"',
      'STU0026\\',
      '',
      'abc',
      'S'.repeat(65),
    ]) {
      expect(STUDENT_ID.test(unsafe)).toBe(false);
    }
  });
});

describe('the sealed expected charge', () => {
  it('round-trips a decimal figure verbatim', () => {
    // Verified against the live gateway: "250.00" is displayed as JMD 250.00.
    expect(openExpectedCharge(sealExpectedCharge('250.00', 'JMD'))).toEqual({
      amount: '250.00',
      currency: 'JMD',
    });
  });

  it('never reformats the figure on the way through', () => {
    /*
      ★ The string survives as a string. What is signed is what is stored is
      what the customer is shown — and a JS number would quietly end that:
      `Number("250.00")` is `250`, so a numeric field would drop the decimals
      between the record and the receipt.
    */
    expect(openExpectedCharge(sealExpectedCharge('250.00', 'JMD')).amount).toBe('250.00');
    expect(openExpectedCharge(sealExpectedCharge('0.05', 'JMD')).amount).toBe('0.05');
    expect(openExpectedCharge(sealExpectedCharge('1000000.99', 'USD')).amount).toBe('1000000.99');
  });

  it('keeps the figure and its currency together, so they cannot drift apart', () => {
    const sealed = sealExpectedCharge('250.00', 'JMD');
    expect(openExpectedCharge(sealed).currency).toBe('JMD');
  });

  it.each([
    '250.000',
    '0250.00',
    '250,00',
    '-250.00',
    '250.00 ',
    '2.5e2',
    'abc',
    '',
  ])('refuses %p, which is not a decimal figure the gateway accepts', (amount) => {
    /*
      These are the shapes that are genuinely AMBIGUOUS rather than merely
      untidy: a third decimal place implies precision the currency does not
      have, a leading zero and a comma are two spellings of one separator, a
      trailing space survives a copy-paste, and scientific notation is a number
      wearing a different hat.

      Whole numbers and a single decimal place ARE accepted — `250` and `250.0`
      are ordinary figures an operator types, and the gateway displays them as
      250.00. Refusing them would be pedantry that pushes people to work out the
      house style rather than to enter the right amount. What matters is that
      the string is passed through untouched: nothing here is ever reformatted,
      so there is no case where what we store and what we charge can disagree.
    */
    expect(() => sealExpectedCharge(amount, 'JMD')).toThrow(ValidationError);
  });

  it('accepts the shapes a real invoice amount arrives in', () => {
    // Including the forms this test previously refused: `250` is 250.00 and
    // `1500.5` is 1500.50, and both are figures a person types without thinking.
    for (const amount of ['0.01', '9.99', '250.00', '250', '250.0', '1500', '1500.5', '1000000.99']) {
      expect(() => sealExpectedCharge(amount, 'JMD')).not.toThrow();
    }
  });

  it('never stores the figure in the clear', () => {
    const sealed = sealExpectedCharge('250.00', 'JMD');
    expect(sealed.includes('250.00')).toBe(false);
  });

  it('refuses an unsealed or corrupt value rather than returning something plausible', () => {
    expect(() => openExpectedCharge(Buffer.from('not-a-number'))).toThrow();
    expect(() =>
      openExpectedCharge(sealExpectedCharge('250.00', 'JMD').subarray(0, 12)),
    ).toThrow();
  });

  it('refuses a sealed charge naming a currency the gateway does not document', () => {
    const forged = sealSecret(JSON.stringify({ amount: '250.00', currency: 'EUR' }));
    expect(() => openExpectedCharge(forged)).toThrow(/unsupported currency/);
  });
});