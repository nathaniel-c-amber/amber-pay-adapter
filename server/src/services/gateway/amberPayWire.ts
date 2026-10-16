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

import { randomBytes, randomInt } from 'node:crypto';
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

/* --- the status token ------------------------------------------------------ */

/**
 * How many random bytes a status token carries. 32 bytes = 256 bits.
 *
 * This is the one identifier in the system that IS a credential: it is minted
 * for a browser that has no session and is the only thing that authorises the
 * unauthenticated status read. 256 bits is past any enumeration concern by a
 * wide margin, which is what is why it can be stored in the clear and read more
 * than once (see migration 009 for why it is not single-use).
 */
export const STATUS_TOKEN_BYTES = 32;

/** base64url of 32 bytes. Length is derived, not asserted twice. */
export const STATUS_TOKEN_LENGTH = 43;

/**
 * The token's exact shape, so a malformed one can be refused with a 400 instead
 * of being handed to the database as an equality probe against a unique index.
 *
 * It is base64url WITHOUT padding: `+` and `/` are the two characters that have
 * to be percent-encoded to survive a query string, a fragment and a copy-paste,
 * and a value that needs encoding in a URL is a value that will arrive mangled.
 */
export const STATUS_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * How long a minted status token stays readable.
 *
 * Deliberately NOT single-use — a customer who refreshes the page they just paid
 * on must not be shown a dead link, so the token is read repeatedly until this
 * window closes. 30 days is long enough for a forwarded thread or a re-opened
 * browser and short enough that a link left in a chat log has stopped working.
 * See `db/migrations/009_checkout_status_token.sql` for the full argument.
 */
export const STATUS_TOKEN_TTL_DAYS = 30;

/** Mint a status token. `randomBytes` is CSPRNG-backed and has no modulo bias. */
export function generateStatusToken(): string {
  return randomBytes(STATUS_TOKEN_BYTES).toString('base64url');
}

/** Is this the shape of a token we minted? Used to refuse a malformed one early. */
export function isStatusToken(value: string): boolean {
  return STATUS_TOKEN.test(value);
}

/**
 * When a token minted at `from` stops resolving.
 *
 * A function rather than a constant applied at the read site so the expiry is
 * written once, with the rest of the row, and the public read is a plain
 * equality probe with a comparison the database already has an operator for.
 */
export function statusTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + STATUS_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
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
  /** MAJOR units, verbatim — "250.00", never 25000. See `DECIMAL_AMOUNT`. */
  Amount: string;
  SignType: 1;
}

/** The parameters the browser posts to `standard-checkout`. */
export interface StandardCheckoutParams {
  ClientId: string;
  TransactionId: string;
  CurrencyCode: GatewayCurrency;
  /** MAJOR units, verbatim — "250.00". */
  Amount: string;
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
  /**
   * The handle the CUSTOMER holds on this payment — the token the public status
   * endpoint resolves, and the one the webhook route redirects a browser back
   * with once the gateway answers.
   *
   * It exists because the gateway's redirect and its callback are the same URL:
   * whoever lands there has no session, and no other value on this session is
   * something they can carry. It is minted with the intent, stored beside it,
   * and lives exactly as long as the intent does.
   */
  statusToken: string;
  /** True when produced locally rather than by the gateway. Never in production. */
  simulated?: boolean;
}

/* --- the expected figure, sealed ------------------------------------------ */

/**
 * A DECIMAL AMOUNT, as the gateway wants it: MAJOR units, up to two decimal
 * places.
 *
 * ★ CORRECTED AGAINST THE LIVE GATEWAY, and the earlier assumption was wrong in
 * a way that would have charged somebody 100× too much.
 *
 * This was modelled as MINOR units — an integer, with `25000` meaning `250.00`.
 * Asking the gateway what it actually displays settles it:
 *
 *     Amount: "250.00"  ->  Total Amount: JMD 250.00
 *     Amount: "25000"   ->  Total Amount: JMD 25000.00
 *     Amount: "99.99"   ->  Total Amount: JMD 99.99
 *
 * So the figure is major units, formatted with at most two decimals, and is
 * passed through VERBATIM. The gateway appends `.00` to an integer, so the
 * formatting we send is for us, not for it — but sending a formatted string
 * keeps what we recorded and what we signed identical, which is the property
 * that makes the anti-fraud cross-check meaningful.
 *
 * IT IS A STRING, NOT A NUMBER, and that is not fussiness. A JS number cannot
 * represent every two-decimal value exactly, and `Number("250.00")` is `250` —
 * so a numeric field would quietly drop the decimals on the way through, and a
 * signature computed over one figure while the customer is shown another is
 * exactly the failure the signature exists to prevent.
 */
export const DECIMAL_AMOUNT = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;

/** The amount a checkout expects to be charged, in one sealed value. */
export interface ExpectedCharge {
  /** MAJOR units, verbatim — e.g. "250.00". Never coerced to a number. */
  amount: string;
  currency: GatewayCurrency;
}

/**
 * Seal the expected charge.
 *
 * THE AMOUNT AND THE CURRENCY ARE SEALED TOGETHER, which is not tidiness. Two
 * separate columns would let them drift — a figure read against a currency that
 * no longer matches it is a cross-check that silently compares the wrong things,
 * and the only symptom would be a mismatch nobody can explain. A figure and its
 * unit are one fact, so they are stored as one.
 *
 * It also satisfies the schema's own rule (`db/migrations.test.ts` forbids a
 * currency column outright) without weakening it or renaming around it.
 *
 * THE AMOUNT IS VALIDATED AS A STRING AND STORED AS ONE. There is no arithmetic
 * here at all, deliberately: no rounding, no unit conversion, no float. What is
 * signed is exactly what is stored is exactly what the customer is shown.
 */
export function sealExpectedCharge(amount: string, currency: GatewayCurrency): Buffer {
  if (!DECIMAL_AMOUNT.test(amount)) {
    throw new ValidationError(
      'Amount must be a decimal figure in major units with at most two decimal places, such as 250.00',
    );
  }
  return sealSecret(JSON.stringify({ amount, currency }));
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
  const { amount, currency } = (parsed ?? {}) as Partial<ExpectedCharge>;
  if (typeof amount !== 'string' || !DECIMAL_AMOUNT.test(amount)) {
    throw new ValidationError('The stored charge is not a valid figure');
  }
  if (currency !== 'USD' && currency !== 'JMD') {
    throw new ValidationError('The stored charge names an unsupported currency');
  }
  return { amount, currency };
}