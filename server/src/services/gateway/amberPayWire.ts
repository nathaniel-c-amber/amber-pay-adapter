/* Amber Pay checkout wire shapes, the sealed amount, and our transaction id.
 *
 * ★ THE SECOND FILE IN THE REPOSITORY WHERE A FIGURE MAY EXIST — and it exists
 * for a reason that is not the QuickBooks one.
 *
 * `quickbooksWire.ts` holds money because QuickBooks REQUIRES an amount to apply
 * a payment to an invoice. This one holds it because the gateway requires
 * `Amount` and `CurrencyCode` to generate a signature at all: there is no way to
 * create a checkout without them. The doc also requires storing them, so the
 * amount paid can be cross-checked against what was expected — the anti-fraud
 * check the gateway's own documentation asks for.
 *
 * SO THIS IS NOT THE SAME FIGURE AS THE OTHER ONE, and the difference is worth
 * stating plainly:
 *   - `quickbooksWire.ts`  — what the LEDGER says is owed, read from an invoice.
 *   - here                 — what the CUSTOMER was asked to pay, so a signed
 *                            request can be made and later checked.
 *
 * NEITHER may reach a domain type, an event, a failure, a log line, or an HTTP
 * response body beyond the amount the operator just typed. `privacy.test.ts`
 * scans the server source and fails on a money field in any interface outside
 * this file and `quickbooksWire.ts` — that allow-list is an explicit exception,
 * documented at the test, not a quiet widening.
 *
 * The amount is SEALED rather than plainly stored. That is arguably more than a
 * bare figure needs, and the reason is specific: it means a database dump on its
 * own cannot be cross-checked or replayed, and the read path stays explicit —
 * `openCheckoutAmount` is a conspicuous call rather than a column anyone
 * selects casually.
 */

import { randomInt } from 'node:crypto';
import { sealSecret, openSecret } from '../../utils/secrets.js';
import { ValidationError } from '../../utils/errors.js';

/** The currencies the gateway documents. Anything else is refused, not coerced. */
export const GATEWAY_CURRENCIES = ['USD', 'JMD'] as const;
export type GatewayCurrency = (typeof GATEWAY_CURRENCIES)[number];

/**
 * How many characters a transaction id may be.
 *
 * The documentation says 8–12 and a real callback echoes a 12-character value,
 * so 12 is the ceiling we generate to. Its own suggested recipe
 * (`YYYYMMDDHHMMSS` + 2–4 digits) is 16–18 characters and would EXCEED that, so
 * it is deliberately not followed.
 */
export const TRANSACTION_ID_LENGTH = 12;
const TRANSACTION_ID_MIN_LENGTH = 8;

/**
 * The alphabet an id is drawn from.
 *
 * Alphanumeric only, deliberately: the id is echoed into a callback and compared
 * against a stored row, and a value with no punctuation in it cannot confuse a
 * delimiter or a query. `randomInt` is used rather than a modulo of a random byte
 * so every character is uniformly distributed — `% 36` over a byte would bias
 * the first six values.
 */
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generate the transaction id this deployment issues to the gateway.
 *
 * OURS, and generated BEFORE checkout — the documentation is explicit that the
 * client generates and stores it "exactly before the customer initiates the
 * payment process", and the callback echoes it back. That echo is the only link
 * between a callback and our own record, so the value has to be persisted first
 * (see `CheckoutIntent`) or a payment could complete against nothing.
 *
 * It is NOT derived from the timestamp. A time-prefixed id is guessable, and this
 * value is not a secret, but it does not need to be enumerable either — and a
 * collision is the one failure that must not happen here.
 *
 * Uniqueness is ultimately the DATABASE's job (`UNIQUE (organization_id,
 * transaction_id)`); this only makes a collision rare enough that the retry path
 * is a formality rather than the normal case.
 */
export function generateTransactionId(): string {
  let id = '';
  for (let index = 0; index < TRANSACTION_ID_LENGTH; index += 1) {
    id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return id;
}

/** Is this the shape of an id we issued? Used to refuse a nonsense one early. */
export function isTransactionId(value: string): boolean {
  if (value.length < TRANSACTION_ID_MIN_LENGTH || value.length > TRANSACTION_ID_LENGTH) return false;
  return [...value].every((character) => ID_ALPHABET.includes(character));
}

/**
 * The customer's identifier, as the gateway echoes it back on the callback.
 *
 * THE SAME CHARSET RULE AS EVERY OTHER IDENTIFIER IN THIS REPOSITORY — no quote,
 * no backslash, no space — because this value is interpolated into a query
 * against the organization's own accounting data. It is allowed to be short: a
 * real one is `STU0026`, seven characters, and an 8+ floor rejects it.
 */
export const STUDENT_ID = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * The request that mints a signature.
 *
 * `Amount` is in MINOR UNITS (the gateway's own convention — a `JMD` payment of
 * 250.00 arrives as `25000`). Storing and comparing is therefore exact integer
 * arithmetic: no float ever touches a figure on this path.
 *
 * `SignType: 1` is what the documentation specifies for a standard checkout.
 */
export interface GenerateSignatureRequest {
  ClientId: string;
  TransactionId: string;
  CurrencyCode: GatewayCurrency;
  Amount: number;
  SignType: 1;
}

/** The parameters the browser posts to `standard-checkout`. */
export interface StandardCheckoutParams {
  ClientId: string;
  TransactionId: string;
  CurrencyCode: GatewayCurrency;
  Amount: number;
  Signature: string;
  /** The customer, echoed back on the callback. Our own field, per the gateway. */
  CustomerReference: string;
  CustomerInvoice: 'Y' | 'N';
  ReturnToMerchant: 'Y' | 'N';
  AutoRedirect: 'Y' | 'N';
}

/**
 * What `POST /payments` now returns.
 *
 * NOT a link. The gateway does not issue a URL a customer can visit: it expects
 * a signed POST to its checkout endpoint and answers with the payment form. So
 * the honest result is the set of parameters and the target — and calling it a
 * `linkUrl`, as this did, was a fabrication that could never work.
 */
export interface CheckoutSession {
  /** Where the browser POSTs. Built from configured host + path. */
  checkoutUrl: string;
  params: StandardCheckoutParams;
  /** Our transaction id, for correlating the callback. */
  transactionId: string;
  /** True when produced locally rather than by the gateway. Never in production. */
  simulated?: boolean;
}

/* --- the expected figure, sealed ------------------------------------------ */

/**
 * What a checkout expects to be charged, in one sealed value.
 *
 * `amountMinorUnits` follows the gateway's own convention — 25000 is 250.00 — so
 * no float ever touches a figure on this path.
 */
export interface ExpectedCharge {
  amountMinorUnits: number;
  currency: GatewayCurrency;
}

/**
 * Seal the expected charge.
 *
 * THE AMOUNT AND THE CURRENCY ARE SEALED TOGETHER, which is not tidiness. Two
 * separate columns would let them drift — a figure of 25000 read against a
 * currency that no longer matches it is a cross-check that silently compares
 * the wrong things, and the only symptom would be a mismatch nobody can explain.
 * A figure and its unit are one fact, so they are stored as one.
 *
 * It also satisfies the schema's own rule (`db/migrations.test.ts` forbids a
 * currency column outright) without weakening it or renaming around it.
 *
 * Exact INTEGER arithmetic only. A float cannot represent every minor-unit
 * value, and rounding a figure that a signature is computed over produces a
 * signature the gateway rejects — or, worse, accepts for a different sum.
 */
export function sealExpectedCharge(amountMinorUnits: number, currency: GatewayCurrency): Buffer {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new ValidationError('Amount must be a whole number of minor units greater than zero');
  }
  return sealSecret(JSON.stringify({ amountMinorUnits, currency }));
}

/**
 * Read the expected charge back, for the anti-fraud cross-check.
 *
 * Named conspicuously because this is the ONLY way a stored figure becomes
 * readable, and reading it is a deliberate act: it exists to compare what the
 * gateway says was charged against what we expected. A failure here throws
 * rather than returning something plausible — a cross-check that cannot run is
 * not a passing cross-check.
 */
export function openExpectedCharge(sealed: Buffer): ExpectedCharge {
  let parsed: unknown;
  try {
    parsed = JSON.parse(openSecret(sealed));
  } catch {
    throw new ValidationError('The stored charge could not be read');
  }
  const { amountMinorUnits, currency } = (parsed ?? {}) as Partial<ExpectedCharge>;
  if (!Number.isInteger(amountMinorUnits) || (amountMinorUnits as number) <= 0) {
    throw new ValidationError('The stored charge is not a valid figure');
  }
  if (currency !== 'USD' && currency !== 'JMD') {
    throw new ValidationError('The stored charge names an unsupported currency');
  }
  return { amountMinorUnits: amountMinorUnits as number, currency };
}