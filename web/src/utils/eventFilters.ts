/**
 * Event filtering, as one pure model.
 *
 * Both the event log and the Payments page narrow the same list by the same four
 * dimensions — type, channel, connection, time — and duplicating that here and
 * there would let the two pages disagree about what "declined" or "the last
 * hour" means. The pages own the controls; this owns the meaning.
 */

import type { EventType, LifecycleEvent } from "@/types/domain";

/* ------------------------------------------------------------------ families */

/**
 * Event types grouped the way an operator asks about them.
 *
 * Eleven chips would be a wall, and nobody thinks "show me `payment-declined`,
 * `payment-failed` and `payment-refunded`" — they think "show me payments". The
 * taxonomy already existed implicitly in `Tables.tsx`'s `EVENT_ORDER`, whose
 * comment separates adaptor reachability as "infrastructure, not a payment
 * phase"; this names it so a filter can use it.
 */
export type EventFamily = "payment" | "accounting" | "infrastructure";

export const EVENT_FAMILY: Record<EventType, EventFamily> = {
  initiated: "payment",
  collected: "payment",
  "payment-declined": "payment",
  "payment-failed": "payment",
  "payment-refunded": "payment",
  "webhook-received": "accounting",
  "record-updated": "accounting",
  "sync-change": "accounting",
  "adaptor-unreachable": "infrastructure",
  "adaptor-auth-failed": "infrastructure",
  "adaptor-restored": "infrastructure",
};

export const FAMILY_LABEL: Record<EventFamily, string> = {
  payment: "Payment",
  accounting: "Accounting",
  infrastructure: "Infrastructure",
};

export const FAMILY_ORDER: readonly EventFamily[] = [
  "payment",
  "accounting",
  "infrastructure",
];

/** The types in each family. Derived, so the two can never disagree. */
export const FAMILY_TYPES: Record<EventFamily, readonly EventType[]> = FAMILY_ORDER.reduce(
  (acc, family) => {
    acc[family] = (Object.keys(EVENT_FAMILY) as EventType[]).filter(
      (type) => EVENT_FAMILY[type] === family,
    );
    return acc;
  },
  {} as Record<EventFamily, readonly EventType[]>,
);

/* ------------------------------------------------------------------ outcomes */

/**
 * The payment lifecycle's outcomes, as the page asks about them.
 *
 * Kept as explicit groups rather than a bare list of types because one of them
 * — declined/failed — is a pair. That pairing is not arbitrary: it is what the
 * page's own KPI counts and calls "Declined / failed", so the filter and the
 * figure beside it have to mean the same thing or clicking the figure would
 * land on a different number.
 */
export const PAYMENT_OUTCOMES = [
  { id: "collected", label: "Collected", types: ["collected"] },
  { id: "initiated", label: "Initiated", types: ["initiated"] },
  { id: "declined", label: "Declined", types: ["payment-declined"] },
  { id: "failed", label: "Failed", types: ["payment-failed"] },
  { id: "refunded", label: "Refunded", types: ["payment-refunded"] },
] as const satisfies readonly { id: string; label: string; types: readonly EventType[] }[];

export type PaymentOutcomeId = (typeof PAYMENT_OUTCOMES)[number]["id"];

/** The group the "Declined / failed" KPI counts, so the two cannot diverge. */
export const UNSETTLED_OUTCOMES: readonly PaymentOutcomeId[] = ["declined", "failed"];

function typesForOutcomes(ids: ReadonlySet<string>): Set<EventType> {
  const types = new Set<EventType>();
  for (const outcome of PAYMENT_OUTCOMES) {
    if (ids.has(outcome.id)) outcome.types.forEach((type) => types.add(type));
  }
  return types;
}

/* -------------------------------------------------------------------- window */

export type WindowPreset = "1h" | "24h" | "7d" | "all";

export const WINDOW_PRESETS: readonly { id: WindowPreset; label: string; ms: number | null }[] = [
  { id: "1h", label: "1h", ms: 60 * 60 * 1000 },
  { id: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "all", label: "All", ms: null },
];

/**
 * A time window is EITHER a preset OR a custom range, never both.
 *
 * A discriminated union rather than two independent fields, because two fields
 * admit a state where a preset and a range are both set and the reader has to
 * guess which wins. Picking one replaces the other by construction.
 */
export type Window =
  | { kind: "preset"; preset: WindowPreset }
  | { kind: "custom"; from: string; to: string };

export const ALL_TIME: Window = { kind: "preset", preset: "all" };

/* ------------------------------------------------------------------- filters */

export interface EventFilters {
  /** Empty means every family, not none — an untouched filter is not a filter. */
  families: ReadonlySet<EventFamily>;
  channels: ReadonlySet<string>;
  /** Adaptor refs. Empty means every connection. */
  connections: ReadonlySet<string>;
  /** Payment outcome groups. Empty means every outcome. */
  outcomes: ReadonlySet<string>;
  window: Window;
}

export const NO_FILTERS: EventFilters = {
  families: new Set(),
  channels: new Set(),
  connections: new Set(),
  outcomes: new Set(),
  window: ALL_TIME,
};

/** True when nothing is narrowing the list, so the UI can hide its clear control. */
export function isUnfiltered(filters: EventFilters): boolean {
  return (
    filters.families.size === 0 &&
    filters.channels.size === 0 &&
    filters.connections.size === 0 &&
    filters.outcomes.size === 0 &&
    filters.window.kind === "preset" &&
    filters.window.preset === "all"
  );
}

/** The instant a window starts at, or null for "no lower bound". */
function windowStart(window: Window, now: number): number | null {
  if (window.kind === "custom") {
    const from = Date.parse(window.from);
    return Number.isNaN(from) ? null : from;
  }
  const preset = WINDOW_PRESETS.find((p) => p.id === window.preset);
  return preset?.ms == null ? null : now - preset.ms;
}

function windowEnd(window: Window): number | null {
  if (window.kind !== "custom") return null;
  const to = Date.parse(window.to);
  return Number.isNaN(to) ? null : to;
}

/**
 * Narrow a list of events.
 *
 * `now` is a parameter rather than `Date.now()` inside, because the window is
 * relative and a function that reads the clock cannot be tested without either
 * flakiness or a fake timer — and this is the one piece of the feature that has
 * a boundary in it.
 *
 * Axes compose with AND; the selections within an axis compose with OR. That is
 * what "declined or failed, in the last hour" means, and the opposite — every
 * axis ORed — would widen a list when the operator asked to narrow it.
 */
export function filterEvents(
  events: readonly LifecycleEvent[],
  filters: EventFilters,
  now: number = Date.now(),
): LifecycleEvent[] {
  const start = windowStart(filters.window, now);
  const end = windowEnd(filters.window);

  const familyTypes = new Set<EventType>();
  for (const family of filters.families) {
    FAMILY_TYPES[family].forEach((type) => familyTypes.add(type));
  }
  const outcomeTypes = typesForOutcomes(filters.outcomes);

  return events.filter((event) => {
    if (familyTypes.size > 0 && !familyTypes.has(event.type)) return false;
    if (outcomeTypes.size > 0 && !outcomeTypes.has(event.type)) return false;
    if (filters.channels.size > 0 && !filters.channels.has(event.channel)) return false;
    if (filters.connections.size > 0 && !filters.connections.has(event.ref)) return false;

    const at = Date.parse(event.at);
    // An unparseable timestamp is kept rather than dropped: it is a fact the
    // operator needs to see, and silently hiding it under a time filter would
    // turn a data problem into an empty list.
    if (Number.isNaN(at)) return true;
    if (start !== null && at < start) return false;
    if (end !== null && at > end) return false;

    return true;
  });
}

/** Distinct connection refs present in a list, for building the connection filter. */
export function connectionRefs(events: readonly LifecycleEvent[]): string[] {
  return [...new Set(events.map((event) => event.ref))].sort((a, b) => a.localeCompare(b));
}

/** Distinct channels present in a list, in the canonical order. */
const CHANNEL_ORDER = ["payment", "accounting", "webhook", "system"] as const;
export function channelsPresent(events: readonly LifecycleEvent[]): string[] {
  const present = new Set(events.map((event) => event.channel));
  const known = CHANNEL_ORDER.filter((channel) => present.has(channel));
  const unknown = [...present].filter((c) => !(CHANNEL_ORDER as readonly string[]).includes(c)).sort();
  return [...known, ...unknown];
}

/** How many events each family currently holds, for the chip counts. */
export function familyCounts(events: readonly LifecycleEvent[]): Record<EventFamily, number> {
  const counts = { payment: 0, accounting: 0, infrastructure: 0 } as Record<EventFamily, number>;
  for (const event of events) counts[EVENT_FAMILY[event.type]] += 1;
  return counts;
}

/** How many events each payment outcome currently holds. */
export function outcomeCounts(events: readonly LifecycleEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of PAYMENT_OUTCOMES) {
    counts[outcome.id] = events.filter((event) =>
      (outcome.types as readonly EventType[]).includes(event.type),
    ).length;
  }
  return counts;
}
