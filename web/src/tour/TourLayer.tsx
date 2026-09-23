/* The tour's one visible surface: a spotlight, a panel, three controls.
 *
 * Presentational and prop-driven — Shell owns which step is showing, because
 * Shell is what knows the identity, the policy and the route. This file owns the
 * accessibility contract and the geometry, and nothing else.
 *
 * A11Y NOTES (why, not just what):
 *  - `role="dialog"` + `aria-modal="true"` + labelled/described. The sign-in
 *    surface in this codebase once shipped a dialog with none of that, and the
 *    lesson was that a visually obvious overlay is invisible to a screen reader.
 *  - Focus moves to the panel on every step change, which is what announces the
 *    new title and body. There is deliberately NO live region as well: a live
 *    region on top of a focus move reads every step twice.
 *  - The trap is short because `inert` already does the heavy lifting — Shell
 *    makes the entire console inert while the tour is active, so the only
 *    focusable elements left are this panel's controls. Wrapping Tab at the ends
 *    keeps them cycling rather than escaping into browser chrome.
 *  - Position is NOT transitioned. A panel that animates between anchors leaves
 *    controls "in flight" (which has broken Playwright actionability in this repo
 *    before), and the global reduced-motion rule in `tailwind.css` only collapses
 *    durations rather than removing movement. Snapping is instant for everyone.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BTN, BTN_PRIMARY, LINK_BTN } from "@/components/ui";
import { placePanel } from "./engine";
import type { Rect } from "./engine";
import type { AnchorState } from "./useAnchorRect";
import type { TourStep } from "./steps";

/** How far the spotlight bleeds past the anchor, in px. */
const SPOTLIGHT_PAD = 6;

/** The scrim, reusing the arbitrary-value literal the drawer backdrop already uses. */
const SCRIM = "absolute inset-0 bg-[rgb(4_7_16/0.72)]";

/**
 * A stand-in rect for a centred step. `placePanel` ignores the rect when asked
 * for `center` — it centres against the viewport — so passing the real anchor is
 * only meaningful for the anchored sides.
 */
const NO_RECT: Rect = { top: 0, left: 0, width: 0, height: 0 };

export interface TourLayerProps {
  step: TourStep;
  /** 1-based position among the steps this policy can actually see. */
  position: number;
  /** How many steps this policy can see — not `TOUR_STEPS.length`. */
  total: number;
  anchor: AnchorState;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  /** Escape, or "Not now": dismiss for this session without stamping. */
  onDismiss: () => void;
}

/** Window size, tracked so a resize re-places a centred panel too. */
function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
}

export function TourLayer({
  step,
  position,
  total,
  anchor,
  onNext,
  onBack,
  onSkip,
  onDismiss,
}: TourLayerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState({ width: 0, height: 0 });
  const viewport = useViewport();
  const titleId = useId();
  const bodyId = useId();

  // The panel's own size is measured rather than assumed: placement needs the
  // real height, and the width is clamped by a breakpoint variant.
  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPanel({ width: rect.width, height: rect.height });
  }, [step.id, position, viewport.width, viewport.height]);

  // Enter the step. Focus lands on the panel rather than on "Next", so a screen
  // reader reads the step from its title; a user pressing Enter gets Next anyway.
  useEffect(() => {
    panelRef.current?.focus();
  }, [step.id]);

  // Escape closes the tour. Document-level, because a keyboard user should never
  // have to find a particular control to leave.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  const trapTab = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const controls = Array.from(
      panel.querySelectorAll<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])"),
    ).filter((el) => !el.hasAttribute("disabled"));
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  }, []);

  const spotlight =
    anchor.status === "ready"
      ? {
          top: anchor.rect.top - SPOTLIGHT_PAD,
          left: anchor.rect.left - SPOTLIGHT_PAD,
          width: anchor.rect.width + SPOTLIGHT_PAD * 2,
          height: anchor.rect.height + SPOTLIGHT_PAD * 2,
        }
      : null;

  const panelAt =
    panel.width > 0
      ? spotlight
        ? placePanel(spotlight, panel, step.placement ?? "bottom", viewport)
        : placePanel(NO_RECT, panel, "center", viewport)
      : null;

  const isLast = position >= total;
  // The panel is withheld while the anchor resolves, but the dim is not: an
  // inert console with no visible overlay reads as a frozen page, and a slow
  // data read can hold that state for up to the anchor timeout.
  const showPanel = anchor.status === "centered" || anchor.status === "ready";

  return (
    <div className="fixed inset-0 z-50" data-tour-layer="">
      {/*
        The dim and the hole are one element: a transparent box over the anchor
        with a 9999px shadow spread paints everything else. A separate full-screen
        scrim plus a cut-out would need two elements whose seams can miss by a
        pixel during a re-layout.
      */}
      {spotlight ? (
        <div
          className="absolute rounded-panel border border-[var(--color-focus)] shadow-[0_0_0_9999px_rgb(4_7_16/0.72)]"
          style={spotlight}
          aria-hidden
        />
      ) : (
        <div className={SCRIM} aria-hidden />
      )}

      {showPanel && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          tabIndex={-1}
          onKeyDown={trapTab}
          className="absolute flex w-[360px] max-xs:w-[calc(100vw-2rem)] flex-col gap-3 rounded-panel border border-rule-enamel bg-midnight-2 p-4 shadow-panel animate-[fadeIn_0.2s_ease-out]"
          style={panelAt ?? undefined}
        >
          <div className="mono text-micro uppercase tracking-label text-ink-3">
            Step {position} of {total}
          </div>
          <h2 id={titleId} className="m-0 text-xl font-semibold leading-tight text-ink-1">
            {step.title}
          </h2>
          <p id={bodyId} className="m-0 text-md leading-prose text-ink-2">
            {step.body}
          </p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <button type="button" className={LINK_BTN} onClick={onSkip}>
              Skip tour
            </button>
            <div className="flex items-center gap-2">
              {position > 1 && (
                <button type="button" className={BTN} onClick={onBack}>
                  Back
                </button>
              )}
              <button type="button" className={BTN_PRIMARY} onClick={onNext}>
                {isLast ? "Done" : "Next"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
