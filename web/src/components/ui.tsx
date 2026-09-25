/* Small shared presentational atoms for the Amber Daylight shell and pages. */
import type { ReactNode } from "react";
import { IconChevronRight, IconAlert, IconCheck, IconClock, IconSearch, IconSync } from "./icons";
import { Can } from "./Can";
import { ABILITY } from "@/utils/permissions";
import {
  HEALTH_OF,
  HEALTH_LABEL,
  SEVERITY_LABEL,
} from "@/utils/vocabulary";
import type { Health } from "@/utils/vocabulary";
import { formatDateTime } from "@/utils/datetime";
import type { Connector, Failure, Severity } from "@/types/domain";

export const cx = (...names: Array<string | false | null | undefined>): string =>
  names.filter(Boolean).join(" ");

/* ---------------------------------------------------------------- treatments
   The old sheet expressed each state as its own selector pair
   (`.amb-pill.healthy`, `.amb-pill.degraded`, …) — 12 rules that had to be
   kept in sync by hand and could silently lack a treatment for a new value.
   These lookups pair the ink and the surface, so a state without a treatment
   is a type error instead of an unstyled badge. */

const HEALTH_PILL: Record<Health, string> = {
  healthy: "text-line-green bg-state-tint-arriving",
  degraded: "text-state-delayed bg-state-tint-delayed",
  failed: "text-text-suspended bg-state-tint-suspended",
  stopped: "text-ink-2 bg-midnight-3",
  unknown: "text-ink-3 bg-midnight-3",
};

const SEVERITY_TONE: Record<"critical" | "warning" | "info", string> = {
  critical: "text-text-suspended bg-state-tint-suspended",
  warning: "text-state-delayed bg-state-tint-delayed",
  info: "text-secondary-ink bg-secondary-soft",
};

/* The KPI's status rail. `--rule-enamel` is the untinted default. */
const KPI_RAIL: Record<"good" | "bad" | "warn" | "neutral", string> = {
  good: "before:bg-line-green",
  warn: "before:bg-line-amber",
  bad: "before:bg-line-scarlet",
  neutral: "before:bg-rule-enamel",
};

const KPI_VALUE: Record<"good" | "bad" | "warn" | "neutral", string> = {
  good: "text-line-green",
  warn: "text-state-delayed",
  bad: "text-text-suspended",
  neutral: "text-ink-1",
};

const LAMP: Record<string, string> = {
  scarlet: "bg-line-scarlet shadow-[0_0_0_1px_var(--color-line-scarlet)]",
  cobalt: "bg-line-cobalt shadow-[0_0_0_1px_var(--color-line-cobalt)]",
  amber: "bg-line-amber shadow-[0_0_0_1px_var(--color-line-amber)]",
  green: "bg-line-green shadow-[0_0_0_1px_var(--color-line-green)]",
};

/* Shared pill geometry: health and severity badges duplicated these five
   declarations in the old sheet. */
const PILL =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-chip px-2 py-0.5 text-xs font-semibold";
/* The shape mark, so status is never carried by colour alone. */
const MARK = "flex-none size-[7px] rounded-[1px] bg-current";

/* Buttons. The tone is part of each definition rather than a class layered on
   top, because Tailwind emits same-property utilities in scale order and NOT in
   class-attribute order: `border-primary` is written before
   `border-rule-enamel` in the compiled sheet, so composing `BTN` + `BTN_PRIMARY`
   would silently give the primary action a slate border. Self-contained
   variants make the winner unambiguous by construction. */
const BTN_BASE =
  "inline-flex cursor-pointer items-center gap-2 rounded-panel border px-3 py-1.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:text-current";
export const BTN = `${BTN_BASE} border-rule-enamel bg-midnight-3 text-ink-1 hover:not-disabled:border-ink-4 hover:not-disabled:bg-midnight-2`;
export const BTN_PRIMARY = `${BTN_BASE} border-primary bg-primary text-on-primary hover:not-disabled:border-primary-hover hover:not-disabled:bg-primary-hover`;

/* Secondary text button (the old `.amb-link-btn`). */
/* Secondary text button (the old `.amb-link-btn`).
   `whitespace-nowrap` because a button's LABEL is a phrase, and a phrase broken
   per-word across three lines ("Full / event / log") reads as a layout accident
   rather than as the control the operator meant to press. Every label this is
   used for is short; if one ever is not, the button should widen, not wrap. */
export const LINK_BTN =
  "inline-flex items-center gap-[2px] cursor-pointer whitespace-nowrap rounded-panel border border-rule-enamel bg-transparent px-2 py-1 text-xs text-primary-ink transition-colors hover:not-disabled:bg-primary-soft hover:not-disabled:text-primary-hover disabled:cursor-not-allowed disabled:opacity-45";

/* Uppercase micro-label: the most repeated type pattern in the app. */
export const LABEL = "text-micro leading-snug uppercase tracking-label";

/*
  Text input. Lifted out of `InvitePage`, where it was written inline twice, so the
  onboarding wizard does not become a third hand-typed copy — a control that differs
  by one border or focus colour between surfaces is the kind of drift nobody files.

  `field-autofill` is a real hook in `tailwind.css` (@layer base): it overrides the
  browser's autofill wash, which paints a light background on a dark field.

  `placeholder:text-ink-4` is the PLACEHOLDER TOKEN for every field in the console,
  and `ink-4` is the dimmest step of the ink ramp (ink-1 is the input's own text
  colour). Two search boxes had it on `ink-3`, which is one step BRIGHTER — so a
  placeholder read as almost-content, and a placeholder must read as less than
  content by definition. Anything that dims its placeholder uses ink-4.
*/
export const INPUT =
  "field-autofill w-full rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2 text-md text-ink-1 placeholder:text-ink-4 transition-colors hover:border-ink-4 focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-[invalid=true]:border-text-suspended";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className={`mono text-xs uppercase tracking-label text-ink-3`}>{children}</div>;
}

export function PageHeader({
  title,
  lead,
  actions,
  tourId,
}: {
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
  /** `data-tour` anchor name. Lets the first-run tour point at this header. */
  tourId?: string;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4" data-tour={tourId}>
      <div>
        <h1 className="text-2xl text-ink-1">{title}</h1>
        {lead ? <p className="mt-1.5 max-w-[60ch] text-md text-ink-2">{lead}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-3">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  meta,
  children,
  className,
  actions,
  tourId,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
  /**
   * `data-tour` anchor name. A prop rather than a raw attribute at the call site
   * because the anchor has to land on the card's own element — passing
   * `data-tour` to a component that spreads nothing would silently do nothing,
   * and a step whose anchor never appears is skipped quietly by design.
   */
  tourId?: string;
}) {
  return (
    <section
      data-tour={tourId}
      className={cx(
        "rounded-panel border border-rule-enamel bg-midnight-2 px-5 py-4 shadow-panel transition-colors hover:border-ink-4",
        className,
      )}
    >
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-3">
            {title ? <h2 className="text-ink-1">{title}</h2> : null}
            {meta ? <span className="text-xs text-ink-3">{meta}</span> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatusPill({
  status,
  live,
}: {
  status: "open" | "arriving" | "delayed" | "suspended";
  live?: boolean;
}) {
  const health = HEALTH_OF[status];
  return (
    <span className={cx(PILL, HEALTH_PILL[health])}>
      {/* Live readings get a pulse; the animation lives on the dot itself, so
          no `.live` modifier class is needed. */}
      {Boolean(live) && <span className="animate-pill flex-none size-[7px] rounded-full bg-current" aria-hidden />}
      <span className={MARK} aria-hidden />
      {HEALTH_LABEL[health]}
    </span>
  );
}

/** Health badge for a connection: Healthy · Degraded · Failed · Stopped · Unknown. */
export function HealthBadge({ health, live }: { health: Health; live?: boolean }) {
  return (
    <span className={cx(PILL, HEALTH_PILL[health])}>
      {Boolean(live) && <span className="animate-pill flex-none size-[7px] rounded-full bg-current" aria-hidden />}
      <span className={MARK} aria-hidden />
      {HEALTH_LABEL[health]}
    </span>
  );
}

/** Severity badge, kept separate from health: Critical · Warning · Info. */
export function SeverityBadge({ severity }: { severity: Severity | "info" }) {
  const label = severity === "attention" ? SEVERITY_LABEL.attention : severity === "critical" ? SEVERITY_LABEL.critical : "Info";
  const tone = severity === "critical" ? "critical" : severity === "attention" ? "warning" : "info";
  return (
    <span className={cx(PILL, "font-mono uppercase tracking-label", SEVERITY_TONE[tone])}>
      <span className={MARK} aria-hidden />
      {label}
    </span>
  );
}

export function Kpi({
  label,
  value,
  note,
  tone,
  icon,
  valueTone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "good" | "bad" | "warn" | "neutral";
  icon?: ReactNode;
  /**
   * Tone of the *value text* when it differs from the card's overall tone.
   * Use "neutral" when the value is a plain count that sits alongside a
   * worse tone (e.g. "2 / 4" healthy connections in a card whose rail is
   * red because another connection failed) — painting the healthy count
   * red would contradict the words.
   */
  valueTone?: "good" | "bad" | "warn" | "neutral";
}) {
  /* valueTone outranks tone: the old sheet ordered `.value-neutral` after the
     `.tone-*` value rules, so it won on equal specificity. Resolving to a
     single class here avoids relying on Tailwind's utility ordering. */
  const valueClass = KPI_VALUE[valueTone ?? tone ?? "neutral"];
  return (
    <div
      className={cx(
        "relative rounded-panel border border-rule-enamel bg-midnight-2 p-4 shadow-panel",
        "before:absolute before:inset-y-[0.8rem] before:left-0 before:w-0.5 before:rounded-[1px] before:content-['']",
        KPI_RAIL[tone ?? "neutral"],
      )}
    >
      <div className="flex items-center justify-between">
        <span className={`mono ${LABEL} text-ink-3`}>{label}</span>
        {icon ? <span className="text-ink-3">{icon}</span> : null}
      </div>
      <div className={cx("mono mt-2 text-3xl font-semibold", valueClass)}>{value}</div>
      {note ? <div className="mt-1 text-xs text-ink-2">{note}</div> : null}
    </div>
  );
}

export function Crumb({ text }: { text: string }) {
  return (
    <span className="amb-crumb">
      <IconChevronRight />
      {text}
    </span>
  );
}

export function DemoTag() {
  return (
    <span
      className="mono whitespace-nowrap rounded-chip border border-[rgb(230_161_42/0.5)] px-2 py-0.5 text-micro uppercase tracking-label text-line-amber"
      title="Synthetic demonstration data"
    >
      Demo
    </span>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={`mono ${LABEL} text-ink-3`}>{label}</span>
      <span className="text-md text-ink-1">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Redesign primitives: drillable rows, finding cards, and states.     */
/* ------------------------------------------------------------------ */

/** One operational path on the overview connection table. Clickable → detail. */
export function ConnectionRow({
  connector,
  onOpen,
}: {
  connector: Connector;
  onOpen: (id: string) => void;
}) {
  const health = HEALTH_OF[connector.status];
  return (
    <button
      type="button"
      className="group grid w-full cursor-pointer grid-cols-[14px_minmax(0,1.6fr)_auto_minmax(80px,0.7fr)_minmax(0,1.3fr)_16px] items-center gap-3 rounded-panel border-b border-rule-enamel-soft bg-transparent p-3 text-left transition-colors last:border-b-0 hover:bg-midnight-3 focus-visible:bg-midnight-3"
      onClick={() => onOpen(connector.id)}
      aria-label={`${connector.label}: ${HEALTH_LABEL[health]}. Open connection detail.`}
    >
      <span className={cx("size-3 rounded-[2px]", LAMP[connector.color] ?? "")} aria-hidden />
      <span className="min-w-0 text-md font-semibold text-ink-1">
        {connector.label}
        <small className="block text-xs font-regular text-ink-3">{connector.terminus}</small>
      </span>
      <HealthBadge health={health} live={connector.status === "open" && connector.reading.toLowerCase().includes("live")} />
      <span className="mono text-sm font-semibold text-ink-1">{connector.reading}</span>
      <span className="text-xs text-ink-2">{connector.note}</span>
      <span className="grid place-items-center text-ink-3 group-hover:text-ink-1" aria-hidden>
        <IconChevronRight />
      </span>
    </button>
  );
}

/** A finding rendered as an incident/task card, not a table row.
 *
 * Acknowledge is gated on the active policy in place (see `Can`) rather than
 * on a `canAck` boolean threaded down from the shell: the card already knows
 * what it is, so every call site used to have to pass the same answer. */
export function FindingCard({
  finding,
  onAck,
  onOpen,
}: {
  finding: Failure;
  onAck: (id: string) => void;
  onOpen?: (id: string) => void;
}) {
  return (
    <article
      className="flex flex-col gap-2 rounded-panel border border-rule-enamel bg-midnight px-4 py-3 data-[severity=critical]:border-[rgb(248_113_113/0.3)] data-[severity=attention]:border-[rgb(251_191_36/0.26)]"
      data-severity={finding.severity}
    >
      <header className="flex flex-wrap items-center gap-3">
        <SeverityBadge severity={finding.severity} />
        <span className="mono text-xs text-ink-2 wrap-anywhere">{finding.id}</span>
        <span className="mono ml-auto text-xs text-ink-3 wrap-anywhere">
          since {formatDateTime(finding.since)}
        </span>
      </header>
      <div>
        {/* h2, not h3: this card sits directly under the page's h1 on the
            findings surfaces, so h3 skipped a level. */}
        <h2 className="text-lg text-ink-1 wrap-anywhere">{finding.title}</h2>
        <div className="mt-1 text-xs text-ink-3 wrap-anywhere">{finding.channel}</div>
        {/*
          `wrap-anywhere`, and it is load-bearing rather than decorative.

          A finding's detail routinely carries the upstream request that failed —
          "Upstream request to https://api.example.com/v3/company/… failed" — and
          a URL has no spaces, so there is nothing for the line breaker to break
          on and the whole string ran out past the card's edge and was clipped.

          `break-words` would NOT have fixed it: it sets `overflow-wrap: break-word`,
          which lets a word break once it has already overflowed, and it does not
          shrink the element's min-content width. `wrap-anywhere` does, which is
          what stops a flex or grid child from being forced wider than its track.
        */}
        <p className="mt-1.5 max-w-[66ch] text-sm text-ink-2 wrap-anywhere">{finding.detail}</p>
      </div>
      <footer className="flex flex-wrap items-center gap-2">
        {onOpen && (
          <button type="button" className={BTN} onClick={() => onOpen(finding.id)}>
            View incident
          </button>
        )}
        <Can ability={ABILITY.findingAck}>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => onAck(finding.id)}
            title="Acknowledge this finding"
          >
            Acknowledge
          </button>
        </Can>
      </footer>
    </article>
  );
}

export function EmptyState({
  title,
  lead,
  action,
}: {
  title: string;
  lead?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-panel border border-dashed border-rule-enamel bg-midnight px-5 py-6">
      <span className="grid place-items-center text-line-green" aria-hidden>
        <IconCheck />
      </span>
      <div className="text-lg font-semibold text-ink-1">{title}</div>
      {lead ? <p className="m-0 max-w-[62ch] text-md text-ink-2">{lead}</p> : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label = "Loading monitoring data…" }: { label?: string }) {
  return (
    <div
      className="flex flex-col items-start gap-2 rounded-panel border border-dashed border-rule-enamel bg-midnight px-5 py-6"
      role="status"
      aria-live="polite"
    >
      <span className="animate-spin-slow grid place-items-center text-secondary" aria-hidden>
        <IconSync />
      </span>
      <div className="m-0 max-w-[62ch] text-md text-ink-2">{label}</div>
    </div>
  );
}

export function ErrorState({
  title = "Can't load monitoring data",
  lead,
  retryLabel = "Retry",
  onRetry,
}: {
  title?: string;
  lead?: ReactNode;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex flex-col items-start gap-2 rounded-panel border border-solid border-[rgb(248_113_113/0.3)] bg-midnight px-5 py-6"
      role="alert"
    >
      <span className="grid place-items-center text-text-suspended" aria-hidden>
        <IconAlert />
      </span>
      <div className="text-lg font-semibold text-ink-1">{title}</div>
      {lead ? <p className="m-0 max-w-[62ch] text-md text-ink-2">{lead}</p> : null}
      {onRetry ? (
        <div className="mt-1.5">
          <button type="button" className={BTN_PRIMARY} onClick={onRetry}>
            {retryLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Inline "monitoring data may be stale" notice — distinct from system health. */
export function StaleNotice({ age }: { age: string }) {
  return (
    <div
      className="flex items-center gap-2 rounded-panel border border-[rgb(230_161_42/0.4)] bg-state-tint-delayed px-3 py-2 text-sm text-text-delayed [&_b]:text-ink-1 [&_svg]:flex-none"
      role="status"
    >
      <IconClock />
      <span>
        Monitoring data may be stale. <b>Last update {age} ago.</b> This reflects the dashboard's
        freshness, not the health of the systems it monitors.
      </span>
    </div>
  );
}

/** Compact search input used by the top header and table cards. */
export function SearchBox({
  value,
  onChange,
  placeholder = "Search",
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-panel border border-rule-enamel bg-midnight-2 px-2 py-1.5 [&_svg]:text-ink-3"
      role="search"
    >
      <IconSearch />
      <input
        type="search"
        className="border-none bg-transparent text-sm text-ink-1 outline-none placeholder:text-ink-4"
        placeholder={placeholder}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}