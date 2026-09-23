/* The tour's decisions, with no React and no DOM.
 *
 * Everything consequential about the tour is a pure function of (steps, policy,
 * geometry): which step is next, which steps this account may see at all, and
 * where the panel goes. Keeping that here rather than inside a component is what
 * makes the awkward cases — a step the policy forbids, an anchor near the edge
 * of a short viewport — assertable instead of only observable.
 */

import { can } from "@/utils/permissions";
import type { PolicyScope } from "@/types/domain";
import type { TourStep } from "./steps";

/* ------------------------------------------------------------------ gating */

/**
 * May this policy be shown this step?
 *
 * `requires` is an `ABILITY` from the same vocabulary every other gate uses, so
 * the tour cannot drift into its own idea of who may see what.
 */
export function stepAllowed(step: TourStep, policy: PolicyScope | null | undefined): boolean {
  return step.requires === undefined || can(policy, step.requires);
}

/** The first step at or after `from` this policy may see, or null for none. */
export function firstShowable(
  steps: readonly TourStep[],
  from: number,
  policy: PolicyScope | null | undefined,
): number | null {
  for (let i = Math.max(from, 0); i < steps.length; i += 1) {
    if (stepAllowed(steps[i], policy)) return i;
  }
  return null;
}

/**
 * The next step after `current`, skipping any this policy may not see.
 *
 * The skip is the whole reason this cannot be `current + 1`: a user whose
 * policy omits the dashboard still completes the tour, just a shorter one.
 */
export function nextShowable(
  steps: readonly TourStep[],
  current: number,
  policy: PolicyScope | null | undefined,
): number | null {
  return firstShowable(steps, current + 1, policy);
}

/** The previous step before `current`, skipping any this policy may not see. */
export function prevShowable(
  steps: readonly TourStep[],
  current: number,
  policy: PolicyScope | null | undefined,
): number | null {
  for (let i = current - 1; i >= 0; i -= 1) {
    if (stepAllowed(steps[i], policy)) return i;
  }
  return null;
}

/**
 * How many steps this policy will actually see.
 *
 * The counter says "3 of 6", not "3 of 8": quoting a total that includes steps
 * this account can never be shown would advertise a missing step on every
 * screen of the tour.
 */
export function showableCount(
  steps: readonly TourStep[],
  policy: PolicyScope | null | undefined,
): number {
  return steps.reduce((n, step) => (stepAllowed(step, policy) ? n + 1 : n), 0);
}

/** This step's 1-based position among the showable steps. */
export function showablePosition(
  steps: readonly TourStep[],
  current: number,
  policy: PolicyScope | null | undefined,
): number {
  let n = 0;
  for (let i = 0; i <= current && i < steps.length; i += 1) {
    if (stepAllowed(steps[i], policy)) n += 1;
  }
  return n;
}

/* --------------------------------------------------------------- placement */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Placement = "top" | "bottom" | "left" | "right" | "center";

/** Keep the panel this far from the window edge. */
const EDGE = 8;
/** Distance between the anchor and the panel. */
export const GAP = 12;

const OPPOSITE: Record<Placement, Placement> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
  center: "center",
};

function coordsFor(
  side: Placement,
  rect: Rect,
  panel: Size,
): { top: number; left: number } {
  const centredLeft = rect.left + rect.width / 2 - panel.width / 2;
  const centredTop = rect.top + rect.height / 2 - panel.height / 2;
  switch (side) {
    case "top":
      return { top: rect.top - GAP - panel.height, left: centredLeft };
    case "bottom":
      return { top: rect.top + rect.height + GAP, left: centredLeft };
    case "left":
      return { top: centredTop, left: rect.left - GAP - panel.width };
    case "right":
      return { top: centredTop, left: rect.left + rect.width + GAP };
    default:
      return { top: centredTop, left: centredLeft };
  }
}

function fitsInside(coords: { top: number; left: number }, panel: Size, viewport: Size): boolean {
  return (
    coords.top >= EDGE &&
    coords.left >= EDGE &&
    coords.top + panel.height <= viewport.height - EDGE &&
    coords.left + panel.width <= viewport.width - EDGE
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where to put the panel.
 *
 * `placement` is a PREFERENCE, not an instruction. An anchor in the last row of
 * a short viewport has no room beneath it, and a panel positioned half off-screen
 * is worse than one that quietly ignores the preference — so the preferred side
 * is tried, then its opposite, then the remaining sides, and only if none of them
 * fits is the preferred side clamped back into view. A clamped panel may overlap
 * its anchor; that is the last resort, and it is still fully readable.
 *
 * Viewport is passed in rather than read from `window` so this stays pure.
 */
export function placePanel(
  rect: Rect,
  panel: Size,
  placement: Placement,
  viewport: Size,
): { top: number; left: number } {
  if (placement === "center") {
    return {
      top: clamp((viewport.height - panel.height) / 2, EDGE, viewport.height - panel.height - EDGE),
      left: clamp((viewport.width - panel.width) / 2, EDGE, viewport.width - panel.width - EDGE),
    };
  }

  const candidates: Placement[] = [
    placement,
    OPPOSITE[placement],
    "bottom",
    "top",
    "right",
    "left",
  ];
  for (const side of candidates) {
    const coords = coordsFor(side, rect, panel);
    if (fitsInside(coords, panel, viewport)) return coords;
  }

  const preferred = coordsFor(placement, rect, panel);
  return {
    top: clamp(preferred.top, EDGE, viewport.height - panel.height - EDGE),
    left: clamp(preferred.left, EDGE, viewport.width - panel.width - EDGE),
  };
}
