/**
 * Test helpers for asserting the privacy guarantees (FR-2.3 / FR-5.2).
 */

/** Keys that must never appear in API responses. */
export const SENSITIVE_KEYS = [
  'amount',
  'currency',
  'card',
  'cardNumber',
  'customer',
  'ssn',
  'iban',
  'accountNumber',
  'balance',
  'total',
  'price',
  'value',
];

/** Recursively collect every key in a JSON-like value. */
export function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, acc);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      acc.push(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

/** Return any sensitive keys present in a JSON-like value. */
export function forbiddenKeysIn(value: unknown): string[] {
  return collectKeys(value).filter((key) => SENSITIVE_KEYS.includes(key));
}
