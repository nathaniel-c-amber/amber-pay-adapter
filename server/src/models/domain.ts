/**
 * Domain types mirroring REQUIREMENTS §6 data model, but constrained by the
 * strict privacy rule: NO financial amounts, NO customer PII, NO raw card data.
 * Only operational lifecycle events, connector states, and reference hashes.
 *
 * PRIVACY CONVENTION (enforced by tests in `privacy.test.ts`):
 * - Operational/monitoring types (Invoice, Payment, ReconciliationJob,
 *   LifecycleEvent, ConnectorState, Failure, PolicyScope, Account) MUST NOT
 *   expose keys such as `amount`, `currency`, `card`, `customer`, `email`,
 *   `ssn`, `iban`, `accountNumber`, `balance`, `total`, `price`, `value`.
 * - Free-text fields (`LifecycleEvent.detail`, `ConnectorState.reading`/`note`,
 *   `Failure.title`/`detail`) are human-readable operational text only. They
 *   MUST NOT carry financial or customer data; the pino logger redacts
 *   sensitive keys so nothing leaks into logs.
 * - `User` is an auth entity (invite email + credential hash) and is the only
 *   type that legitimately holds an email address.
 *
 * TENANCY: every operational/monitoring entity carries `organizationId`. Rows
 * are stored org-scoped and reads are always filtered by the caller's
 * authorized organizations, so PBAC org checks actually restrict returned data.
 */

// --- Identifier aliases ---
export type UserId = string;
export type AccountId = string;
export type InvoiceId = string;
export type PaymentId = string;
export type ReconciliationJobId = string;
export type LifecycleEventId = string;
export type ConnectorStateId = string;
export type FailureId = string;
export type PolicyScopeId = string;

// --- Core entities ---

export interface User {
  id: UserId;
  email: string;
  hashedPassword: string;
  /**
   * When the first-run guided tour was finished or explicitly skipped (ISO
   * 8601), or `null` when it has not been offered yet. The console offers the
   * tour once to an account that carries no stamp; Profile can replay it
   * regardless. Operational metadata only — never PII, never financial data.
   */
  tourCompletedAt: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * `Account` represents an accounting/ledger account (organization-scoped),
 * NOT a customer account. `name` is a ledger account name, not customer PII.
 */
export interface Account {
  id: AccountId;
  name: string;
  organizationId: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'overdue' | 'void';

export interface Invoice {
  id: InvoiceId;
  accountId: AccountId;
  organizationId: string;
  /** External reference hash / id (e.g. QuickBooks). No financial data. */
  externalInvoiceId: string;
  status: InvoiceStatus;
  dueDate: string; // ISO 8601
  // NOTE: no amount/currency per privacy constraint.
}

export type PaymentStatus = 'initiated' | 'collected' | 'failed' | 'refunded';

export interface Payment {
  id: PaymentId;
  invoiceId: InvoiceId;
  organizationId: string;
  /** Reference hash of the gateway transaction. No financial data. */
  transactionId: string;
  status: PaymentStatus;
  processedAt: string; // ISO 8601
  // NOTE: no amount per privacy constraint.
}

export type ReconciliationJobStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Operational reconciliation summary. Counts only — NO amounts, NO PII.
 */
export interface ReconciliationSummary {
  status: string;
  matched: number;
  unmatched: number;
  anomalies: number;
  ranAt: string; // ISO 8601
}

export interface ReconciliationJob {
  id: ReconciliationJobId;
  organizationId: string;
  runAt: string; // ISO 8601
  status: ReconciliationJobStatus;
  summary: ReconciliationSummary;
}

// --- Monitoring types ---

export type LifecycleEventType =
  | 'initiated'
  | 'collected'
  | 'record-updated'
  | 'sync-change'
  | 'webhook-received'
  | 'payment-declined'
  | 'payment-failed'
  | 'payment-refunded'
  // Adaptor reachability. These belong in the lifecycle log because "the
  // accounting link is down" and "a payment did not reach the ledger" are the
  // same story told from two ends, and an operator debugging a missing posting
  // needs both. `adaptor-auth-failed` is split from `adaptor-unreachable`
  // because a rejected token and an unreachable host have opposite remedies.
  | 'adaptor-unreachable'
  | 'adaptor-auth-failed'
  | 'adaptor-restored';

export type LifecycleChannel = 'payment' | 'accounting' | 'webhook' | 'system';

export interface LifecycleEvent {
  id: LifecycleEventId;
  organizationId: string;
  at: string; // ISO 8601
  type: LifecycleEventType;
  channel: LifecycleChannel;
  /** Reference hash of the related entity. No financial data. */
  ref: string;
  /** Human-readable operational text only. No financial/customer data. */
  detail: string;
}

export type ConnectorStatus = 'open' | 'arriving' | 'delayed' | 'suspended';

export type ConnectorTerminus = 'quickbooks' | 'sage' | 'amber-pay' | 'audit-trail';

export interface ConnectorState {
  id: ConnectorStateId;
  organizationId: string;
  label: string;
  terminus: ConnectorTerminus;
  status: ConnectorStatus;
  /** Human-readable operational text only. No financial/customer data. */
  reading: string;
  /** Human-readable operational text only. No financial/customer data. */
  note: string;
}

export type Severity = 'critical' | 'attention';

export interface Failure {
  id: FailureId;
  organizationId: string;
  severity: Severity;
  channel: LifecycleChannel;
  /** Human-readable operational text only. No financial/customer data. */
  title: string;
  /** Human-readable operational text only. No financial/customer data. */
  detail: string;
  since: string; // ISO 8601
  acknowledgedAt?: string; // ISO 8601 — present once acknowledged
}

// --- Stage flow (payment -> accounting) ---
//
// The operator's real question is a FLOW question — where are payments
// sitting? — not a resource question. These types describe an item's progress
// through the four stages of the gateway->accounting link, derived from the
// lifecycle events above. Counts and durations only; no amounts, no PII.

export type FlowStage = 'initiated' | 'collected' | 'ingested' | 'posted';

/** Per-stage targets. `warnMs`/`failMs` bound the time to LEAVE the stage. */
export interface StageThresholds {
  warnMs: number;
  failMs: number;
}

export type StageState = 'healthy' | 'degraded' | 'failed' | 'not-reporting';

export interface StageFlow {
  stage: FlowStage;
  state: StageState;
  /** Refs that reached this stage. */
  entered: number;
  /**
   * Refs waiting at this stage to advance — reached it, not failed, and not
   * yet at the next stage. NEVER counts items sitting at the terminal stage:
   * a posted item has finished, and counting it as waiting would inflate the
   * blast radius on a healthy system.
   */
  inFlight: number;
  /** Refs that advanced beyond this stage. */
  exited: number;
  /** Refs that finished at this stage (terminal stage only). */
  completed: number;
  /** Refs halted here by a declined/failed payment event. */
  failed: number;
  /** When the longest-waiting in-flight item entered (ISO 8601), if any. */
  oldestInFlightAt: string | null;
  /** p95 of time-to-leave-this-stage. Null when no item has left yet. */
  dwellP95Ms: number | null;
  /** How many dwell observations the p95 was computed from. */
  sampleSize: number;
  thresholds: StageThresholds;
  /**
   * True when no item reached this stage in the window. Silence must never be
   * rendered as health: an unconfigured or unreachable path looks different
   * from a passing one.
   */
  notReporting: boolean;
}

export interface StageFlowSummary {
  stages: StageFlow[];
  /** Distinct refs seen in the window. */
  trackedRefs: number;
  /** Longest wait across all stages (ISO 8601), if anything is waiting. */
  oldestInFlightAt: string | null;
  failedRefs: number;
  window: { from: string | null; to: string | null };
  /** Rows the derivation actually saw. */
  eventsConsidered: number;
  /**
   * The repository caps the event list, so a ref whose later event falls
   * outside the window looks stalled. When true the UI MUST label the counts
   * as sampled rather than presenting them as authoritative.
   */
  mayBeTruncated: boolean;
  computedAt: string;
}

export type PolicyAction = 'read' | 'ack' | 'write' | 'admin';

export interface PolicyScope {
  id: PolicyScopeId;
  label: string;
  attributes: Record<string, string>;
  readOnly: boolean;
}
