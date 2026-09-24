import type { PaymentStatus } from '../models/domain.js';

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
 * Why an adaptor probe failed, as a value rather than a sentence.
 *
 * The lifecycle event recorder has to tell "the token expired" from "the
 * network is down" because they need opposite responses, and scraping a status
 * code out of a human-readable `message` with a regex is exactly the kind of
 * coupling that silently breaks when someone rewords the message.
 */
export type AdaptorFailureReason = 'auth' | 'rate-limited' | 'unreachable' | 'upstream';

/**
 * Health probe result. Unlike push/sync, health checks REPORT rather than
 * throw: `ok:false` + `message` is returned on a non-2xx response so callers
 * can distinguish healthy from unhealthy without exception handling.
 */
export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
  /** Present when `ok` is false; classifies the failure for callers. */
  reason?: AdaptorFailureReason;
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
 * Credentials for one accounting connection, SUPPLIED by the caller.
 *
 * THE ADAPTOR READS NO ENVIRONMENT. It used to call `env.QUICKBOOKS_*` inside
 * `connect()`, which made credentials a property of the process rather than of
 * the deployment's configuration record — so there was nowhere to put a value an
 * administrator had entered, and a rotated refresh token had nowhere to be
 * written back to. Every field is optional because "configured but missing a
 * piece" is a real state whose error message an operator needs to read.
 */
export interface AdaptorCredentials {
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
  /** The accounting company / tenant the credentials are scoped to. */
  realmId?: string;
  accessToken?: string;
  refreshToken?: string;
}

/**
 * What a connection attempt learned that the caller must remember.
 *
 * `rotated` exists because some upstreams invalidate a credential as they spend
 * it: Intuit issues a NEW refresh token on every exchange. If the caller does
 * not persist it, the next process start presents a token that has already been
 * used, and the connection dies one token-lifetime after every restart — which
 * looks like flakiness rather than like a bug.
 */
export interface ConnectResult {
  rotated?: AdaptorCredentials;
}

/**
 * The extensibility contract for accounting adaptors. Every accounting
 * platform (QuickBooks, Sage, ...) implements this interface.
 *
 * CONVENTIONS:
 * - `pushCompletedPayment` / `pullSyncStatus` THROW `AdaptorError` on failure.
 * - `healthCheck` reports via `ok:false` + `message` on failure (no throw).
 * - All methods that talk to the upstream MUST be called after `connect()`;
 *   they throw `AdaptorConnectionError` if the adaptor is not connected.
 * - `connect` takes its credentials as an argument and reads no environment.
 */
export interface AccountingAdaptor {
  readonly id: AdaptorId;
  readonly name: string;
  connect(credentials: AdaptorCredentials): Promise<ConnectResult | void>;
  disconnect(): Promise<void>;
  status(): Promise<AdaptorStatus>;
  pushCompletedPayment(payment: PaymentRef): Promise<PushResult>;
  pullSyncStatus(): Promise<SyncResult>;
  healthCheck(): Promise<HealthCheckResult>;
}
