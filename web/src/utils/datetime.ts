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
