/* The unauthenticated surface.
 *
 * Replaces a modal that was built from inline styles and old rem values — the
 * one screen in the app that bypassed the design system entirely, and the one a
 * user meets first. Everything here reads from the same tokens as the console,
 * so the door and the room are the same building.
 *
 * It is deliberately a full page rather than a dialog: sign-in is a task, not
 * an interruption, and the invite flow needs room to explain what an invite
 * actually grants.
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { IconLedger } from "../icons";

/* The panel's backdrop: a ruled ledger under a signal.
 *
 * Two textures, both from the product's own vocabulary rather than a stock
 * decorative wash. The grid is a ledger page's ruling — the brand mark is an
 * open accounting book — built as a `<pattern>`, so it repeats and any crop of
 * the panel still reads as ruled paper (the aside moves under the form at
 * ≤900px, where a composed illustration would be cropped to nonsense).
 *
 * The staircase is the console's own lifecycle rising left to right —
 * `initiated → collected → ingested → posted`, the same four stages FlowSpine
 * draws — and a signal leaves its end as concentric rings, which is the thing
 * this product actually is: a monitoring layer over a link. Colour is spent only
 * on that last run and the ring it feeds, because the design system reserves
 * colour for routes and live states and keeps the field near-black.
 *
 * Linework only — no node glyphs. An earlier pass marked each stage with a small
 * node and ringed the last one, and beside a sentence that ring read as a status
 * lamp: a decoration pretending to be information. The four runs carry the
 * stages on their own. They are also placed high enough in the viewBox (y 380–560
 * of 800) to survive the crop when the aside stacks: `slice` scales that tier by
 * WIDTH, so the bottom ~200 units of the viewBox are cut off there.
 *
 * Decorative by construction: `aria-hidden`, `pointer-events-none`, and painted
 * *behind* the panel's text by the aside's own stacking context (`isolate` +
 * `-z-10`) rather than over it. No motion: nothing here should be busy at the
 * moment someone is trying to sign in.
 */
function AsideLedger() {
  return (
    <svg
      viewBox="0 0 600 800"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute inset-0 -z-10 size-full"
    >
      <defs>
        <pattern id="auth-ledger" patternUnits="userSpaceOnUse" width="100" height="34">
          <path
            className="[stroke:var(--color-rule-enamel)] [stroke-width:1] [stroke-opacity:0.75]"
            d="M0 0.5H100"
          />
          <path
            className="[stroke:var(--color-rule-enamel)] [stroke-width:1] [stroke-opacity:0.45]"
            d="M0.5 0V34"
          />
        </pattern>
      </defs>

      <rect className="[fill:url(#auth-ledger)]" width="600" height="800" />

      {/* Signal leaving the end of the route — the inner ring warms to the brand
          ink so the route visibly feeds it. */}
      <g className="[fill:none] [stroke:var(--color-rule-enamel)] [stroke-width:1] [stroke-opacity:0.5]">
        <circle cx="520" cy="380" r="190" />
        <circle cx="520" cy="380" r="300" />
        <circle cx="520" cy="380" r="430" />
      </g>
      <circle
        className="[fill:none] [stroke:var(--color-primary)] [stroke-width:1] [stroke-opacity:0.3]"
        cx="520"
        cy="380"
        r="90"
      />

      {/* Four stages, ascending: the ledger entry becoming a pushed record. */}
      <path
        className="[fill:none] [stroke:var(--color-ink-3)] [stroke-width:1.5] [stroke-opacity:0.3] [stroke-linejoin:round]"
        d="M40 560H160V500H280V440H400V380"
      />

      {/* The live end of the route. */}
      <path
        className="[fill:none] [stroke:var(--color-primary)] [stroke-width:1.5] [stroke-opacity:0.45]"
        d="M400 380H520"
      />
    </svg>
  );
}

export function AuthShell({
  title,
  lead,
  children,
  footer,
  step,
  totalSteps,
}: {
  title: string;
  lead: string;
  children: ReactNode;
  footer?: ReactNode;
  /** 1-based. Rendered only when the flow genuinely has ordered stages. */
  step?: number;
  totalSteps?: number;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Move focus to the heading on mount: the previous gate left focus on the
  // document body, so a keyboard user started at the top of the document with
  // no indication that a new context had opened.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="grid min-h-dvh grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] bg-midnight max-xl:grid-cols-[minmax(0,1fr)]">
      <main className="mx-auto flex w-full max-w-[34rem] flex-col justify-center gap-5 p-10 max-xl:px-5 max-xl:py-8 max-xs:px-4 max-xs:py-5">
        <div className="flex items-center gap-3">
          <span
            className="grid size-[34px] flex-none place-items-center rounded-panel bg-primary text-on-primary"
            aria-hidden
          >
            <IconLedger size={19} />
          </span>
          <span className="flex flex-col">
            <span className="text-lg font-semibold text-ink-1">Amber Pay Ledger</span>
            <span className="text-xs text-ink-3">Pay Operations</span>
          </span>
        </div>

        <header className="flex flex-col gap-1.5">
          {step !== undefined && totalSteps !== undefined && (
            <p className="mono text-micro uppercase tracking-label text-ink-3">
              Step {step} of {totalSteps}
            </p>
          )}
          <h1
            className="text-3xl font-semibold tracking-tight text-ink-1 focus:outline-none focus-visible:outline-none"
            ref={headingRef}
            tabIndex={-1}
          >
            {title}
          </h1>
          <p className="m-0 max-w-[46ch] text-md leading-prose text-ink-2">{lead}</p>
        </header>

        {children}

        {footer && <footer className="auth-foot">{footer}</footer>}
      </main>

      <aside
        className="relative isolate flex flex-col justify-center gap-4 border-l border-rule-enamel bg-midnight-2 px-8 py-10 max-xl:border-l-0 max-xl:border-t max-xl:border-rule-enamel max-xl:px-5 max-xl:py-8 max-xs:px-4 max-xs:py-5"
        aria-label="About this console"
      >
        <AsideLedger />
        <h2 className="text-xl font-semibold text-ink-1">What this console is</h2>
        <p className="m-0 max-w-[42ch] text-md leading-prose text-ink-2">
          A monitoring layer over the link between the Amber Pay gateway and your accounting
          software. It reports operational events — references, statuses, timings — and never stores
          or displays payment amounts, card data, or customer details.
        </p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          <li className="relative max-w-none pl-4 text-sm leading-prose text-ink-2 before:absolute before:top-[0.5em] before:left-0 before:size-1.5 before:rounded-[1px] before:bg-line-green before:content-['']">
            Every status is drillable, down to the event that produced it.
          </li>
          <li className="relative max-w-none pl-4 text-sm leading-prose text-ink-2 before:absolute before:top-[0.5em] before:left-0 before:size-1.5 before:rounded-[1px] before:bg-line-green before:content-['']">
            Access is invite-only and governed by policy attributes, not static roles.
          </li>
          <li className="relative max-w-none pl-4 text-sm leading-prose text-ink-2 before:absolute before:top-[0.5em] before:left-0 before:size-1.5 before:rounded-[1px] before:bg-line-green before:content-['']">
            Sign-in requires a second factor by email on every session.
          </li>
        </ul>
      </aside>
    </div>
  );
}

/** A labelled field, so every input in the flow has the same anatomy. */
export function AuthField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="mono text-micro uppercase tracking-label text-ink-3" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && !error && <p className="m-0 text-xs text-ink-3">{hint}</p>}
      {error && (
        <p className="m-0 text-xs text-text-suspended" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
