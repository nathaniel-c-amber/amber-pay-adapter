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
  since: string;
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
    note: "last run 14:45",
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

export const EVENTS: LifecycleEvent[] = [
  { id: "e-941", at: "14:58:02", type: "sync-change", channel: "Scheduled pull", ref: "EVT-9c1", detail: "Sync status change: pull completed, 0 anomalies." },
  { id: "e-940", at: "14:52:41", type: "record-updated", channel: "Payment push", ref: "EVT-8f7", detail: "Record updated successfully at QuickBooks Online." },
  { id: "e-939", at: "14:47:19", type: "webhook-received", channel: "Sage bridge", ref: "EVT-7aa", detail: "Webhook received, processing errored — surfaced to findings." },
  { id: "e-938", at: "14:45:00", type: "initiated", channel: "Payment push", ref: "EVT-7ab", detail: "Transaction initiated: payment link generated via Amber Pay." },
  { id: "e-937", at: "14:39:27", type: "collected", channel: "Payment push", ref: "EVT-6b4", detail: "Payment collected — webhook accepted by adaptor." },
  { id: "e-936", at: "14:21:08", type: "sync-change", channel: "Scheduled pull", ref: "EVT-5d2", detail: "Sync status change: pull scheduled next interval." },
  { id: "e-935", at: "14:02:11", type: "record-updated", channel: "Payment push", ref: "EVT-4c1", detail: "Record updated successfully at QuickBooks Online." },
];

export const FAILURES: Failure[] = [
  {
    id: "F-2074",
    severity: "critical",
    channel: "Sage bridge",
    title: "Webhook processing error",
    detail: "Adaptor stopped accepting events; on-call alerted. Every subsequent event is queued.",
    since: "14:47",
  },
  {
    id: "F-2071",
    severity: "attention",
    channel: "Scheduled pull",
    title: "Pull ran behind schedule",
    detail: "Last pull completed at 14:45 vs the 15 min interval — interval drifted by 2 intervals.",
    since: "14:45",
  },
  {
    id: "F-2068",
    severity: "critical",
    channel: "Payment push",
    title: "Reference hash mismatch",
    detail: "A pushed event could not be matched to a record upstream. Referenced as EVT-7ab.",
    since: "14:39",
  },
];

export const POLICIES: PolicyScope[] = [
  { id: "op-monitor", label: "Ops Monitor", attributes: "sc:ams|org:acme|act:read|act:ack", readOnly: false },
  { id: "audit", label: "Audit", attributes: "sc:ams|org:acme|act:read", readOnly: true },
];

export const DEFAULT_POLICY: PolicyScope = POLICIES[0];

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
