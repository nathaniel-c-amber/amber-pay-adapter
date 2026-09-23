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
        className="flex flex-col justify-center gap-4 border-l border-rule-enamel bg-midnight-2 px-8 py-10 max-xl:border-l-0 max-xl:border-t max-xl:border-rule-enamel max-xl:px-5 max-xl:py-8 max-xs:px-4 max-xs:py-5"
        aria-label="About this console"
      >
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
