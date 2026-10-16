/* Demonstration data for the Amber Pay Ledger monitoring console.
   These are SYNTHETIC fixtures standing in for live API data
   (see REQUIREMENTS.md v2.0.0 §5 /dashboard/metrics, §3.4 FR-5.1).
   They carry NO financial amounts, NO customer PII, and NO ledger
   figures — only operational events, connector states, and hashes,
   per FR-2.3 / FR-5.2. */

export type LineStatus = "open" | "arriving" | "delayed" | "suspended";
export type EventType =
  | "initiated"
  | "collected"
  | "record-updated"
  | "sync-change"
  | "webhook-received"
  | "payment-declined"
  | "payment-failed"
  | "payment-refunded"
  | "adaptor-unreachable"
  | "adaptor-auth-failed"
  | "adaptor-restored";
export type Severity = "critical" | "attention";

export interface Connector {
  id: string;
  label: string;
  terminus: string;
  color: "scarlet" | "cobalt" | "amber" | "green";
  status: LineStatus;
  reading: string;
  note: string;
  segments: number[];
}

export interface LifecycleEvent {
  id: string;
  /** ISO 8601 instant. The view formats it; nothing here is pre-formatted. */
  at: string;
  type: EventType;
  channel: string;
  ref: string;
  detail: string;
}

export interface Failure {
  id: string;
  severity: Severity;
  channel: string;
  title: string;
  detail: string;
  /** ISO 8601 instant. The view formats it; nothing here is pre-formatted. */
  since: string;
  /** ISO 8601 instant, present once the finding has been acknowledged. */
  acknowledgedAt?: string;
  /**
   * Who acknowledged it, from the server. Deliberately OPTIONAL rather than an
   * empty string: a finding acknowledged before attribution existed has a real
   * acknowledgement and an unknown actor, and collapsing that to `""` would
   * make it indistinguishable from one nobody has touched.
   */
  acknowledgedBy?: string;
}

export interface PolicyScope {
  id: string;
  label: string;
  attributes: string;
  readOnly: boolean;
}

export const CONNECTORS: Connector[] = [
  {
    id: "push",
    label: "Payment push",
    terminus: "QuickBooks Online",
    color: "scarlet",
    status: "open",
    reading: "1.8 s",
    note: "target ≤ 5 s",
    segments: [5, 5, 5, 5, 5, 5, 5],
  },
  {
    id: "pull",
    label: "Scheduled pull",
    terminus: "QuickBooks Online",
    color: "cobalt",
    status: "delayed",
    reading: "15 min",
    note: "last run 14 min ago",
    segments: [4, 4, 5, 4, 4, 7, 6],
  },
  {
    id: "sage",
    label: "Sage bridge",
    terminus: "Sage",
    color: "amber",
    status: "suspended",
    reading: "queueing",
    note: "webhook processing error",
    segments: [5, 5, 4, 4, 0, 0, 0],
  },
  {
    id: "events",
    label: "Operational event stream",
    terminus: "Audit trail",
    color: "green",
    status: "open",
    reading: "streaming",
    note: "lifecycle stream",
    segments: [5, 5, 5, 5, 5, 5, 5],
  },
];

/* Fixture timestamps are anchored to module load rather than to a fixed clock.
   The demo has to read as "moments ago": pinning it to, say, 14:58 would either
   age into a date months in the past or — worse, once the date was dropped from
   display — pass an old reading off as today's. */
const FIXTURE_NOW = Date.now();
const minutesAgo = (minutes: number, seconds = 0): string =>
  new Date(FIXTURE_NOW - (minutes * 60 + seconds) * 1000).toISOString();

export const EVENTS: LifecycleEvent[] = [
  { id: "e-941", at: minutesAgo(1), type: "sync-change", channel: "Scheduled pull", ref: "EVT-9c1", detail: "Sync status change: pull completed, 0 anomalies." },
  { id: "e-940", at: minutesAgo(6, 21), type: "record-updated", channel: "Payment push", ref: "EVT-8f7", detail: "Record updated successfully at QuickBooks Online." },
  { id: "e-939", at: minutesAgo(11, 43), type: "webhook-received", channel: "Sage bridge", ref: "EVT-7aa", detail: "Webhook received, processing errored — surfaced to findings." },
  { id: "e-938", at: minutesAgo(14, 2), type: "initiated", channel: "Payment push", ref: "EVT-7ab", detail: "Transaction initiated: payment link generated via Amber Pay." },
  { id: "e-937", at: minutesAgo(19, 35), type: "collected", channel: "Payment push", ref: "EVT-6b4", detail: "Payment collected — webhook accepted by adaptor." },
  { id: "e-936", at: minutesAgo(37, 54), type: "sync-change", channel: "Scheduled pull", ref: "EVT-5d2", detail: "Sync status change: pull scheduled next interval." },
  { id: "e-935", at: minutesAgo(56, 51), type: "record-updated", channel: "Payment push", ref: "EVT-4c1", detail: "Record updated successfully at QuickBooks Online." },
];

export const FAILURES: Failure[] = [
  {
    id: "F-2074",
    severity: "critical",
    channel: "Sage bridge",
    title: "Webhook processing error",
    detail: "Adaptor stopped accepting events; on-call alerted. Every subsequent event is queued.",
    since: minutesAgo(12),
  },
  {
    id: "F-2071",
    severity: "attention",
    channel: "Scheduled pull",
    title: "Pull ran behind schedule",
    detail: "Last pull completed behind the 15 min interval — interval drifted by 2 intervals.",
    since: minutesAgo(14),
  },
  {
    id: "F-2068",
    severity: "critical",
    channel: "Payment push",
    title: "Reference hash mismatch",
    detail: "A pushed event could not be matched to a record upstream. Referenced as EVT-7ab.",
    since: minutesAgo(19),
  },
];

/*
  `POLICIES` and `DEFAULT_POLICY` were DELETED here.

  They had no importers anywhere in `web/` (the live and demo policy sources are
  `services/client.ts` and `utils/fixtures.ts`), so they were dead — and not
  harmlessly so: they carried a second invented organization (`org:acme`) and a
  `sc:`/`org:`/`act:` attribute dialect that `parseAttributes` still tolerates
  but nothing emits. A dead fixture asserting a product shape the product does
  not have is worse than no fixture, because the next reader cannot tell it is
  not load-bearing.
*/

export const STATUS_LABEL: Record<LineStatus, string> = {
  open: "Open",
  arriving: "Arriving",
  delayed: "Delayed",
  suspended: "Suspended",
};

export const EVENT_LABEL: Record<EventType, string> = {
  initiated: "Initiated",
  collected: "Collected",
  "record-updated": "Record updated",
  "sync-change": "Sync change",
  "webhook-received": "Webhook received",
  "payment-declined": "Payment declined",
  "payment-failed": "Payment failed",
  "payment-refunded": "Payment refunded",
  "adaptor-unreachable": "Adaptor unreachable",
  "adaptor-auth-failed": "Adaptor auth failed",
  "adaptor-restored": "Adaptor restored",
};

export const openCount = (connectors: Connector[]): number =>
  connectors.filter((c) => c.status !== "suspended").length;
export const suspendedCount = (connectors: Connector[]): number =>
  connectors.filter((c) => c.status === "suspended").length;
