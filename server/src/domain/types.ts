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
  | 'webhook-received';

export type LifecycleChannel = 'payment' | 'accounting' | 'webhook' | 'system';

export interface LifecycleEvent {
  id: LifecycleEventId;
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
  severity: Severity;
  channel: LifecycleChannel;
  /** Human-readable operational text only. No financial/customer data. */
  title: string;
  /** Human-readable operational text only. No financial/customer data. */
  detail: string;
  since: string; // ISO 8601
}

export type PolicyAction = 'read' | 'ack' | 'write' | 'admin';

export interface PolicyScope {
  id: PolicyScopeId;
  label: string;
  attributes: Record<string, string>;
  readOnly: boolean;
}
