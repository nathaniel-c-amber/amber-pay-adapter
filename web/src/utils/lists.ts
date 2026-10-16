/**
 * List limits, in one place.
 *
 * Every operational list in this console answers to an unbounded source: an
 * incident can be reported hundreds of times, and an event log is capped at 500
 * rows on the server. Rendering all of them inline is what turned the incident
 * detail page into the event log with a header, and what made a connection page
 * taller than the screen several times over.
 *
 * So lists are capped, and the cap is stated rather than silently applied — a
 * list that quietly stops at five is indistinguishable from a list that has only
 * five.
 */

/** Shown while a list is in its default, compact state. */
export const COLLAPSED_LIMIT = 5;

/**
 * The most a "show more" may ever reveal inline.
 *
 * Beyond this the rows belong on the page made for them. Fifty findings is
 * already a wall of scrolling in a panel whose job is a summary, and the
 * complete set has its own route with its own search — so the ceiling is a
 * redirect, not a truncation.
 */
export const EXPANDED_LIMIT = 50;

export interface CappedList<T> {
  /** The rows to render. */
  visible: T[];
  /** How many rows exist but are not rendered right now. */
  hidden: number;
  /** True when even a fully expanded list cannot show everything. */
  atCeiling: boolean;
  /**
   * How many rows CAN be rendered at most — the ceiling, or the whole list when
   * it fits. Distinct from `total` whenever the ceiling bites, and that
   * distinction is the point: a "show more" reaches `reachable`, not `total`.
   */
  reachable: number;
  /** How many rows the full set holds, for the "showing 50 of 500" wording. */
  total: number;
}

/**
 * Cap a list, choosing the limit from whether the operator asked for more.
 *
 * `hidden` counts every row not currently rendered, so a caller can say how much
 * is missing. `reachable` counts only what one more click would reach, which is
 * smaller whenever the ceiling is in the way — a panel with 500 rows collapsed
 * to 5 has 495 hidden but only 45 reachable.
 */
export function capList<T>(items: readonly T[], expanded: boolean): CappedList<T> {
  const reachable = Math.min(items.length, EXPANDED_LIMIT);
  const visible = items.slice(0, expanded ? reachable : COLLAPSED_LIMIT);
  return {
    visible,
    hidden: items.length - visible.length,
    atCeiling: items.length > EXPANDED_LIMIT,
    reachable,
    total: items.length,
  };
}

/**
 * "Showing 50 of 500" — what an expanded list that hit the ceiling must say.
 *
 * Only once it has actually hit the ceiling. Below it, "showing 30 of 30" is
 * noise, and the count is already in the panel header.
 */
export function ceilingNotice(capped: { atCeiling: boolean; visible: unknown[]; total: number }): string | null {
  if (!capped.atCeiling || capped.visible.length < EXPANDED_LIMIT) return null;
  return `Showing ${EXPANDED_LIMIT} of ${capped.total}. The complete set is in the event log.`;
}
