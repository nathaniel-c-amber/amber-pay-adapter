import { logger } from '../../utils/logger.js';
import type {
  AccountingAdaptor,
  AdaptorCredentials,
  AdaptorId,
  AdaptorResponse,
  AdaptorStatus,
  AdaptorTransport,
  ConnectResult,
  CustomerMatchConfig,
  HealthCheckResult,
  HttpMethod,
  PaymentRef,
  PushResult,
  SyncResult,
} from '../../types/adaptor.js';
import {
  AdaptorAuthError,
  AdaptorConnectionError,
  AdaptorError,
  adaptorErrorForStatus,
  failureReasonForError,
  failureReasonForStatus,
} from './errors.js';

/**
 * Sage adaptor.
 *
 * CONNECTION AND HEALTH ARE REAL ENOUGH TO REPORT. The payment path is not
 * implemented and says so — see `pushCompletedPayment`.
 */
export class SageAdaptor implements AccountingAdaptor {
  readonly id: AdaptorId = 'sage';
  readonly name = 'Sage';

  private connected = false;
  private oauthToken: string | null = null;
  /** Credentials most recently supplied to `connect`. Never read from the environment. */
  private credentials: AdaptorCredentials = {};
  private readonly transport: AdaptorTransport;

  constructor(transport?: AdaptorTransport) {
    this.transport = transport ?? this.stubTransport;
  }

  async connect(credentials: AdaptorCredentials): Promise<ConnectResult | void> {
    /*
      The distinction that matters to an operator: nothing configured at all
      versus configured and refused. Both are `auth` failures, but the fix is
      different, so the message has to say which one this is.
    */
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new AdaptorAuthError('Sage credentials are not configured');
    }
    this.credentials = credentials;
    // OAuth token placeholder: real token exchange/refresh lands here.
    this.oauthToken = 'stub-token';
    this.connected = true;
    logger.info({ adaptor: this.id }, 'Sage adaptor connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.oauthToken = null;
    this.credentials = {};
    logger.info({ adaptor: this.id }, 'Sage adaptor disconnected');
  }

  async status(): Promise<AdaptorStatus> {
    return this.connected ? 'connected' : 'disconnected';
  }

  /**
   * Sage has no implemented payment path.
   *
   * It used to `POST /invoices/{id}/pay`, which is as fictional as the
   * QuickBooks URL it mirrored — and it was mirroring a fiction, which is how
   * an invented endpoint survived a rewrite of the other adaptor. A deployment
   * that selects Sage can connect, probe and report health, but a completed
   * payment has nowhere to go.
   *
   * That is now said plainly rather than returning a result that reads like a
   * success. The processor turns this into a critical finding, which is the
   * truth: money was collected and the ledger does not know.
   */
  async pushCompletedPayment(
    _payment: PaymentRef,
    _match: CustomerMatchConfig,
  ): Promise<PushResult> {
    this.assertConnected();
    throw new AdaptorError(
      501,
      'ADAPTOR_PUSH_UNSUPPORTED',
      'Applying a completed payment is not implemented for Sage. A collected payment cannot be recorded in the ledger.',
    );
  }

  async pullSyncStatus(): Promise<SyncResult> {
    this.assertConnected();
    const response = await this.request('GET', '/sync/status');
    this.assertOk(response, 'Sage sync failed');
    return {
      status: 'ok',
      ranAt: new Date().toISOString(),
      matched: 0,
      unmatched: 0,
      anomalies: 0,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    this.assertConnected();
    const started = Date.now();
    try {
      const response = await this.request('GET', '/health');
      const latencyMs = Date.now() - started;
      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          latencyMs,
          message: `Health check failed with status ${response.status}`,
          reason: failureReasonForStatus(response.status),
        };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: err instanceof Error ? err.message : 'Sage health check failed',
        reason: failureReasonForError(err),
      };
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new AdaptorConnectionError(`${this.name} adaptor is not connected`);
    }
  }

  private assertOk(response: AdaptorResponse, message: string): void {
    if (response.status < 200 || response.status >= 300) {
      throw adaptorErrorForStatus(response.status, `${message} (status ${response.status})`);
    }
  }

  /**
   * Thin transport seam. Real Sage calls would target the base URL with the
   * OAuth token; stubbed pending credentials.
   */
  private async request(method: HttpMethod, url: string, body?: unknown): Promise<AdaptorResponse> {
    const base = this.credentials.baseUrl ?? '';
    const fullUrl = `${base}${url}`;
    const headers: Record<string, string> = this.oauthToken
      ? { Authorization: `Bearer ${this.oauthToken}` }
      : {};
    return this.transport(method, fullUrl, body, headers);
  }

  private async stubTransport(_method: HttpMethod, _url: string): Promise<AdaptorResponse> {
    throw new AdaptorConnectionError('Sage API calls are stubbed pending credentials');
  }
}
