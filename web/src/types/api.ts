/* Frontend API types — mirror the backend domain shapes (server/src/models/domain.ts)
   exactly so the mapping layer can translate them into the frontend's display types
   (types/domain.ts). These carry NO financial amounts, NO customer PII, and NO
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

/* ---------------------------------------------------------- stage flow */

export type FlowStage = "initiated" | "collected" | "ingested" | "posted";

export type StageState = "healthy" | "degraded" | "failed" | "not-reporting";

export interface StageThresholds {
  warnMs: number;
  failMs: number;
}

export interface ApiStageFlow {
  stage: FlowStage;
  state: StageState;
  entered: number;
  inFlight: number;
  exited: number;
  completed: number;
  failed: number;
  oldestInFlightAt: string | null;
  dwellP95Ms: number | null;
  sampleSize: number;
  thresholds: StageThresholds;
  notReporting: boolean;
}

export interface ApiStageFlowSummary {
  stages: ApiStageFlow[];
  trackedRefs: number;
  oldestInFlightAt: string | null;
  failedRefs: number;
  window: { from: string | null; to: string | null };
  eventsConsidered: number;
  mayBeTruncated: boolean;
  computedAt: string;
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
  /** Authoritative flow aggregate; absent from older server builds. */
  stages?: ApiStageFlowSummary;
  generatedAt: string;
}

/* ------------------------------------------------------ service status */

export interface ApiAdaptorStatus {
  id: string;
  name: string;
  status: string;
  reachable: boolean;
  latencyMs: number | null;
  message?: string;
}

export interface ApiServiceStatus {
  service: {
    name: string;
    version: string;
    environment: string;
    nodeVersion: string;
    startedAt: string;
    uptimeSeconds: number;
    storage: string;
    eventWindowLimit: number;
    rows: { connectors: number | null; failures: number | null };
    adaptors: ApiAdaptorStatus[];
  };
  generatedAt: string;
}

/* -------------------------------------------------- identity & access */

export type PolicyAction = "read" | "ack" | "write" | "admin";

/** A PBAC grant: `actions` on `scope` within `organizationId`. `*` is wildcard. */
export interface ApiPolicyAttribute {
  scope: string;
  organizationId: string;
  actions: PolicyAction[];
}

/**
 * The caller's own identity (GET /auth/me).
 *
 * `email` is present because `User` is the ONE entity in this product allowed
 * to hold an email address — it is a sign-in identity, never customer PII
 * (FR-2.3). Nothing else about the account is exposed.
 */
export interface ApiIdentity {
  id: string;
  email: string;
  policyAttributes: ApiPolicyAttribute[];
  policies: ApiPolicyScope[];
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * When the first-run guided tour was finished or skipped, or `null` when this
   * account has never been offered it. The console starts the tour only on
   * `null` — the claim is about the account, not the browser, so a second device
   * does not re-tour the same person.
   */
  tourCompletedAt: string | null;
  /** When the current access token stops working (ISO 8601). */
  tokenExpiresAt: string;
}

/**
 * What an outstanding invite carries (GET /auth/invite/:token).
 *
 * No id, no timestamps and no token hash: the accept page needs the address it
 * is inviting and the access it is offering, and nothing else about the invite
 * is any of its business.
 */
export interface ApiInviteDetail {
  email: string;
  policyAttributes: ApiPolicyAttribute[];
  /** When the link stops working (ISO 8601). */
  expiresAt: string;
}

/**
 * One row of the administrator's user directory (GET /users).
 *
 * `invite-pending` means no account exists yet — only an outstanding invite.
 * `id` is the account id for active rows and the invite id for pending ones,
 * which is what the resend action addresses.
 */
export interface ApiDirectoryUser {
  id: string;
  email: string;
  status: "active" | "invite-pending";
  policyAttributes: ApiPolicyAttribute[];
  organizations: string[];
  createdAt: string;
  updatedAt: string;
  inviteExpiresAt?: string;
}