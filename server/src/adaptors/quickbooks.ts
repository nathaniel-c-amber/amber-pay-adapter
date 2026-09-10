import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type {
  AccountingAdaptor,
  AdaptorId,
  AdaptorResponse,
  AdaptorStatus,
  AdaptorTransport,
  HealthCheckResult,
  HttpMethod,
  PaymentRef,
  PushResult,
  SyncResult,
} from './types.js';
import {
  AdaptorAuthError,
  AdaptorConnectionError,
  adaptorErrorForStatus,
} from './errors.js';

/**
 * QuickBooks Online adaptor.
 *
 * NOTE: Real QuickBooks HTTP calls are stubbed pending credentials. The
 * transport (`request`) is the single seam where real API calls will land.
 */
export class QuickBooksAdaptor implements AccountingAdaptor {
  readonly id: AdaptorId = 'quickbooks';
  readonly name = 'QuickBooks Online';

  private connected = false;
  private oauthToken: string | null = null;
  private readonly transport: AdaptorTransport;

  constructor(transport?: AdaptorTransport) {
    this.transport = transport ?? this.stubTransport;
  }

  async connect(): Promise<void> {
    if (!env.QUICKBOOKS_CLIENT_ID || !env.QUICKBOOKS_CLIENT_SECRET) {
      throw new AdaptorAuthError('QuickBooks credentials are not configured');
    }
    // OAuth token placeholder: real token exchange/refresh lands here.
    this.oauthToken = 'stub-token';
    this.connected = true;
    logger.info({ adaptor: this.id }, 'QuickBooks adaptor connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.oauthToken = null;
    logger.info({ adaptor: this.id }, 'QuickBooks adaptor disconnected');
  }

  async status(): Promise<AdaptorStatus> {
    return this.connected ? 'connected' : 'disconnected';
  }

  async pushCompletedPayment(payment: PaymentRef): Promise<PushResult> {
    this.assertConnected();
    const response = await this.request('POST', `/invoices/${payment.externalInvoiceId}/pay`);
    this.assertOk(response, 'QuickBooks push failed');
    return {
      externalRef: payment.transactionId,
      at: new Date().toISOString(),
    };
  }

  async pullSyncStatus(): Promise<SyncResult> {
    this.assertConnected();
    const response = await this.request('GET', '/sync/status');
    this.assertOk(response, 'QuickBooks sync failed');
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
    const response = await this.request('GET', '/health');
    const latencyMs = Date.now() - started;
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        latencyMs,
        message: `Health check failed with status ${response.status}`,
      };
    }
    return { ok: true, latencyMs };
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
   * Thin transport seam. Real QuickBooks calls would target the base URL with
   * the realm id and OAuth token; stubbed pending credentials.
   */
  private async request(method: HttpMethod, url: string, body?: unknown): Promise<AdaptorResponse> {
    const base = env.QUICKBOOKS_BASE_URL ?? '';
    const realm = env.QUICKBOOKS_REALM_ID ?? '';
    const fullUrl = `${base}${realm ? `/realm/${realm}` : ''}${url}`;
    const headers: Record<string, string> = this.oauthToken
      ? { Authorization: `Bearer ${this.oauthToken}` }
      : {};
    return this.transport(method, fullUrl, body, headers);
  }

  private async stubTransport(_method: HttpMethod, _url: string): Promise<AdaptorResponse> {
    throw new AdaptorConnectionError('QuickBooks API calls are stubbed pending credentials');
  }
}
