import type { PaymentStatus } from '../domain/types.js';

/**
 * Adaptor identifiers. Extensible: add new members as new accounting
 * platforms are supported.
 *
 * EXTENSION POINT: adding a new adaptor requires editing this union AND
 * registering it in `registry.ts`.
 */
export type AdaptorId = 'quickbooks' | 'sage';

/**
 * Operational adaptor status. `'error'` and `'syncing'` are reserved for
 * future use (e.g. surfaced from a live connection); the current stub
 * implementations only report `'connected'` / `'disconnected'`.
 */
export type AdaptorStatus = 'connected' | 'disconnected' | 'error' | 'syncing';

/**
 * Operational sync result. Counts only — NO amounts, NO PII.
 *
 * ERROR SIGNALING: methods THROW `AdaptorError` on failure (consistent with
 * the Phase 1 error model). This result is success/warning-shaped only;
 * `status: 'error'` is never returned.
 */
export interface SyncResult {
  status: 'ok' | 'warning';
  ranAt: string; // ISO 8601
  matched: number;
  unmatched: number;
  anomalies: number;
  /** Optional detail accompanying a `'warning'` status. */
  message?: string;
}

/**
 * Success-shaped push result. On failure the method THROWS `AdaptorError`.
 */
export interface PushResult {
  externalRef: string;
  at: string; // ISO 8601
}

/**
 * Health probe result. Unlike push/sync, health checks REPORT rather than
 * throw: `ok:false` + `message` is returned on a non-2xx response so callers
 * can distinguish healthy from unhealthy without exception handling.
 */
export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
}

/**
 * Minimal, privacy-safe reference to a completed payment that an adaptor
 * consumes. NO amounts, NO PII, NO raw card data.
 */
export interface PaymentRef {
  id: string;
  transactionId: string;
  externalInvoiceId: string;
  status: PaymentStatus;
  processedAt: string; // ISO 8601
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Typed transport response. */
export interface AdaptorResponse {
  status: number;
  body: unknown;
}

/**
 * Thin transport seam used by adaptors to make HTTP calls. Real
 * implementations are stubbed pending credentials; tests inject a mock.
 */
export type AdaptorTransport = (
  method: HttpMethod,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<AdaptorResponse>;

/**
 * The extensibility contract for accounting adaptors. Every accounting
 * platform (QuickBooks, Sage, ...) implements this interface.
 *
 * CONVENTIONS:
 * - `pushCompletedPayment` / `pullSyncStatus` THROW `AdaptorError` on failure.
 * - `healthCheck` reports via `ok:false` + `message` on failure (no throw).
 * - All methods that talk to the upstream MUST be called after `connect()`;
 *   they throw `AdaptorConnectionError` if the adaptor is not connected.
 */
export interface AccountingAdaptor {
  readonly id: AdaptorId;
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): Promise<AdaptorStatus>;
  pushCompletedPayment(payment: PaymentRef): Promise<PushResult>;
  pullSyncStatus(): Promise<SyncResult>;
  healthCheck(): Promise<HealthCheckResult>;
}
