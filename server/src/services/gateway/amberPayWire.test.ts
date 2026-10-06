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
  it('round-trips an exact minor-unit figure and its currency', () => {
    // 25000 minor units is 250.00 — the gateway's own convention.
    expect(openExpectedCharge(sealExpectedCharge(25000, 'JMD'))).toEqual({
      amountMinorUnits: 25000,
      currency: 'JMD',
    });
  });

  it('round-trips a figure a float could not represent exactly', () => {
    const awkward = 1000000007;
    expect(openExpectedCharge(sealExpectedCharge(awkward, 'USD')).amountMinorUnits).toBe(awkward);
  });

  it('keeps the figure and its currency together, so they cannot drift apart', () => {
    /*
      The reason these are sealed as ONE value rather than two columns. A figure
      and its unit are a single fact; stored apart they can diverge, and the only
      symptom is a cross-check comparing the wrong things.
    */
    const sealed = sealExpectedCharge(25000, 'JMD');
    expect(openExpectedCharge(sealed).currency).toBe('JMD');
  });

  it('refuses zero, a negative, and a fractional figure', () => {
    // A fractional minor unit is meaningless here, and accepting one would mean
    // rounding somewhere — the exact thing this path must never do.
    expect(() => sealExpectedCharge(0, 'JMD')).toThrow(ValidationError);
    expect(() => sealExpectedCharge(-1, 'JMD')).toThrow(ValidationError);
    expect(() => sealExpectedCharge(10.5, 'JMD')).toThrow(ValidationError);
    expect(() => sealExpectedCharge(Number.NaN, 'JMD')).toThrow(ValidationError);
  });

  it('never stores the figure in the clear', () => {
    const sealed = sealExpectedCharge(25000, 'JMD');
    // Structural check, not a security proof: it catches a future refactor to a
    // plain column, which is the realistic regression.
    expect(sealed.includes('25000')).toBe(false);
  });

  it('refuses an unsealed or corrupt value rather than returning something plausible', () => {
    // A cross-check that cannot run is not a passing cross-check.
    expect(() => openExpectedCharge(Buffer.from('not-a-number'))).toThrow();
    // A truncated envelope has no valid auth tag, so it cannot be opened.
    expect(() =>
      openExpectedCharge(sealExpectedCharge(25000, 'JMD').subarray(0, 12)),
    ).toThrow();
  });

  it('refuses a sealed charge naming a currency the gateway does not document', () => {
    // Built by hand to bypass the sealer, which is the only way to get here — so
    // the reader must still refuse it rather than pass it downstream.
    const forged = sealSecret(JSON.stringify({ amountMinorUnits: 25000, currency: 'EUR' }));
    expect(() => openExpectedCharge(forged)).toThrow(/unsupported currency/);
  });
});