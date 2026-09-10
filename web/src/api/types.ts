/* Frontend API types — mirror the backend domain shapes (server/src/domain/types.ts)
   exactly so the mapping layer can translate them into the frontend's display types
   (src/dashboard/data.ts). These carry NO financial amounts, NO customer PII, and NO
   raw card data — only operational lifecycle events, connector states, and reference
   hashes (FR-2.3 / FR-5.2). */

export type ConnectorTerminus = "quickbooks" | "sage" | "amber-pay" | "audit-trail";
export type ConnectorStatus = "open" | "arriving" | "delayed" | "suspended";

export interface ConnectorState {
  id: string;
  organizationId: string;
  label: string;
  terminus: ConnectorTerminus;
  status: ConnectorStatus;
  reading: string;
  note: string;
}

export type LifecycleEventType =
  | "initiated"
  | "collected"
  | "record-updated"
  | "sync-change"
  | "webhook-received"
  | "payment-declined"
  | "payment-failed";

export type LifecycleChannel = "payment" | "accounting" | "webhook" | "system";

export interface ApiLifecycleEvent {
  id: string;
  organizationId: string;
  at: string;
  type: LifecycleEventType;
  channel: LifecycleChannel;
  ref: string;
  detail: string;
}

export type Severity = "critical" | "attention";

export interface ApiFailure {
  id: string;
  organizationId: string;
  severity: Severity;
  channel: LifecycleChannel;
  title: string;
  detail: string;
  since: string;
  acknowledgedAt?: string;
}

export interface ApiPolicyScope {
  id: string;
  label: string;
  attributes: Record<string, string>;
  readOnly: boolean;
}

/** Shape returned by GET /api/v1/dashboard/metrics. */
export interface MetricsResponse {
  connectors: ConnectorState[];
  events: ApiLifecycleEvent[];
  failures: ApiFailure[];
  policies: ApiPolicyScope[];
  generatedAt: string;
}