/* One owner for every timestamp the console prints.
 *
 * Two rules hold wherever a time appears, and they hold here so they cannot
 * drift page by page:
 *
 *   1. A clock reading is ALWAYS paired with its date. A bare "14:47" invites
 *      the reader to assume today, and on a findings list that is exactly the
 *      wrong assumption to make.
 *   2. A clock reading is 12-hour with an explicit AM/PM marker, so "2:58 PM"
 *      cannot be misread as a 24-hour "14:58" that lost its leading digit.
 *
 * The locale is pinned rather than left to the browser: the format is part of
 * the console's own vocabulary, not the operator's locale preference, and
 * leaving it open lets the SAME field render as "2:58 PM" on one machine and
 * "14:58" or "2:58 p.m." on another. `hour12` is set explicitly for the same
 * reason — it should not depend on a locale default.
 *
 * Precedent for pinning by hand: the email templates format their own stamps
 * rather than inheriting the recipient's. A monitoring console that reports
 * "14:47" to one operator and "2:47 PM" to the next is reporting two things.
 *
 * Four entry points, and the pairing rule decides which to reach for:
 *   - `formatDateTime` / `formatDateTimeSeconds` — the default. Date AND time.
 *   - `formatDate` / `formatTimeOfDay` — used ONLY together, stacked in one
 *     cell (the event log's Time column), where the date still sits directly
 *     beside its time. Never render `formatTimeOfDay` on its own line, or in a
 *     list of them: that is the bare clock reading this module exists to stop.
 */

const LOCALE = "en-US";

const DATE_PARTS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
};

/* Event and log readings keep the seconds: they are the record, and two events
   inside the same minute must not read as simultaneous. */
const DATE_TIME_SECONDS = new Intl.DateTimeFormat(LOCALE, {
  ...DATE_PARTS,
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/* Administrative and "since" stamps are read to the minute; seconds there are
   noise that widens a column without changing a decision. */
const DATE_TIME_MINUTES = new Intl.DateTimeFormat(LOCALE, {
  ...DATE_PARTS,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const DATE_ONLY = new Intl.DateTimeFormat(LOCALE, DATE_PARTS);

/* A window that fits inside one day prints clock readings, so the month and day
   are carried once at the front rather than repeated on both ends. */
const MONTH_DAY = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" });

const TIME_MINUTES = new Intl.DateTimeFormat(LOCALE, {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const TIME_SECONDS = new Intl.DateTimeFormat(LOCALE, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/** Parse an ISO timestamp, or null when it is absent or unusable. */
function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Sep 24, 2026, 2:58 PM" — the date and the time, to the minute. */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? DATE_TIME_MINUTES.format(d) : "—";
}

/** "Sep 24, 2026, 2:58:02 PM" — the date and the time, to the second. */
export function formatDateTimeSeconds(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? DATE_TIME_SECONDS.format(d) : "—";
}

/** "Sep 24, 2026" — the date alone. Pairs with `formatTimeOfDay`. */
export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? DATE_ONLY.format(d) : "—";
}

/**
 * "2:58:02 PM" — the time alone. ONLY for a cell that already shows its date
 * directly beside it; anywhere the date is not adjacent, use
 * `formatDateTimeSeconds` instead.
 */
export function formatTimeOfDay(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? TIME_SECONDS.format(d) : "—";
}

/**
 * The window a repeated incident has been seen in: "Sep 25 – Oct 6, 2026".
 *
 * AN OCCURRENCE RANGE IS NOT TWO TIMESTAMPS. Printing `formatDateTime` at both
 * ends produced a forty-character mono string that competed with the incident's
 * title for attention on a card whose whole job is to be scannable, and it
 * wrapped mid-token on a phone.
 *
 * WHAT IT DROPS, AND WHY IT IS SAFE. Across more than one day the window prints
 * DATES ONLY. That is not a shortcut around rule 1 — it is rule 1 obeyed: there
 * is no clock reading in the output, so there is nothing to pair. The exact
 * instants stay available on the incident page.
 *
 * Below a day, times ARE printed, because then the dates alone would lose the
 * only thing that distinguishes the case: five occurrences in six minutes and
 * five occurrences across six days are identical under dates alone, and they are
 * opposite problems.
 */
export function formatWindow(
  firstIso: string | null | undefined,
  lastIso: string | null | undefined,
): string {
  const first = parse(firstIso);
  const last = parse(lastIso);
  // The `parse`d Dates are handed to the formatters directly rather than back
  // through the exported string helpers, which take ISO strings and would force
  // a re-parse (and a second null check) for no gain.
  if (!first) return last ? DATE_TIME_MINUTES.format(last) : "—";
  if (!last) return DATE_TIME_MINUTES.format(first);
  if (first.getTime() === last.getTime()) return DATE_TIME_MINUTES.format(first);

  const sameDay =
    first.getFullYear() === last.getFullYear() &&
    first.getMonth() === last.getMonth() &&
    first.getDate() === last.getDate();

  if (sameDay) {
    return `${DATE_ONLY.format(first)} · ${TIME_MINUTES.format(first)}–${TIME_MINUTES.format(last)}`;
  }

  const sameYear = first.getFullYear() === last.getFullYear();
  // One year is printed, at the end, and only when both ends share it.
  const from = sameYear ? MONTH_DAY.format(first) : DATE_ONLY.format(first);
  return `${from} – ${DATE_ONLY.format(last)}`;
}
