/* Converting a decimal figure into exact integer minor units.
 *
 * Amounts arrive as the gateway's own decimal string ("250.00"), never as a
 * number, and comparing them must not go through floating-point arithmetic:
 * `250.1 * 100` is `25010.000000000004`, and a comparison that is "nearly"
 * right is not a comparison an accountant will accept.
 *
 * This is deliberately a leaf util with no domain types: the figure is parsed,
 * compared and discarded at the boundary that needs it.
 */

/** A decimal figure in MAJOR units, at most two places. */
const DECIMAL = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/;

/**
 * Parse a decimal string into integer minor units, or `null` when it is not a
 * figure this system would have accepted in the first place.
 */
export function toMinorUnits(value: string): number | null {
  const match = DECIMAL.exec(value);
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const minor = whole * 100 + Number(fraction);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * The same conversion for an upstream number.
 *
 * QuickBooks returns money as a JSON number. `Math.round` is the honest
 * operation here: the value is already the provider's representation of a
 * two-place figure, and rounding only removes the representation error that
 * multiplying by 100 introduces.
 */
export function minorUnitsFromNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}
