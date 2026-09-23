/* Resolving and tracking the element a step points at.
 *
 * Three things make this less trivial than a `getBoundingClientRect`:
 *
 *  1. The anchor may not be mounted yet. A hash-router navigation commits in the
 *     same tick, but a page that awaits data renders its content later — and the
 *     console withholds a page entirely when there is no data source at all. So
 *     resolution polls, with a cap, and "never appeared" is reported as its own
 *     state rather than being confused with "no anchor wanted".
 *  2. The anchor MOVES. The shell polls every 10s, and the service map is not
 *     memoised, so anchors shift under a panel that is merely re-rendered. This
 *     observes geometry instead: a ResizeObserver on the element plus scroll and
 *     resize listeners.
 *  3. Off-screen anchors must be brought into view first, or the panel is placed
 *     against a rect nobody can see.
 */

import { useEffect, useState } from "react";
import { anchorSelector } from "./anchors";
import type { Rect } from "./engine";

/** Give up on an anchor that never mounts. Long enough for a slow data read. */
const ANCHOR_TIMEOUT_MS = 2000;

export type AnchorState =
  /** The step has no anchor: the panel is centred. */
  | { status: "centered" }
  /** Resolution in progress. */
  | { status: "waiting" }
  | { status: "ready"; rect: Rect }
  /** The timeout elapsed without the element appearing — the engine skips ahead. */
  | { status: "absent" };

function measure(element: Element): Rect {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/**
 * Track the rect of `anchor` while `active`.
 *
 * Returns a discriminated state, not a rect-or-null: "this step is centred" and
 * "this step's anchor is missing" lead to opposite behaviour (centre the panel
 * vs skip the step), and collapsing them into a null would make the tour point
 * at nothing.
 */
export function useAnchorRect(anchor: string | undefined, active: boolean): AnchorState {
  const [state, setState] = useState<AnchorState>(
    anchor === undefined ? { status: "centered" } : { status: "waiting" },
  );

  useEffect(() => {
    if (!active) {
      setState({ status: "centered" });
      return;
    }
    if (anchor === undefined) {
      setState({ status: "centered" });
      return;
    }

    /*
      Reset BEFORE resolving. The previous step's rect otherwise survives the
      step change, and the spotlight keeps pointing at the LAST anchor while the
      panel describes the new one — verified live: stepping from the sidebar
      footer to the Profile replay control left the ring on the sidebar item for
      the whole of the next step. Cheap to fix, and invisible in code review.
    */
    setState({ status: "waiting" });

    let frame = 0;
    let observer: ResizeObserver | undefined;
    let element: HTMLElement | null = null;
    let cancelled = false;
    const startedAt = performance.now();

    const remeasure = () => {
      if (cancelled || !element) return;
      setState({ status: "ready", rect: measure(element) });
    };

    // `capture: true` so scroll events from any scroll container are seen, not
    // only the document's own.
    const observeGeometry = () => {
      window.addEventListener("scroll", remeasure, true);
      window.addEventListener("resize", remeasure);
      observer = new ResizeObserver(remeasure);
      if (element) observer.observe(element);
    };

    const resolve = () => {
      if (cancelled) return;
      element = document.querySelector<HTMLElement>(anchorSelector(anchor));
      if (!element) {
        if (performance.now() - startedAt > ANCHOR_TIMEOUT_MS) {
          setState({ status: "absent" });
          return;
        }
        frame = requestAnimationFrame(resolve);
        return;
      }
      // Bring it into view before measuring: a rect taken from an element below
      // the fold places the panel off-screen.
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      remeasure();
      observeGeometry();
    };

    frame = requestAnimationFrame(resolve);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("scroll", remeasure, true);
      window.removeEventListener("resize", remeasure);
    };
  }, [anchor, active]);

  return state;
}
