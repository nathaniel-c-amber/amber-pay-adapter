import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
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
} from '../../types/adaptor.js';
import {
  AdaptorConnectionError,
  adaptorErrorForStatus,
} from './errors.js';
import { httpTransport } from './httpTransport.js';
import { INTUIT_TOKEN_URL, resolveAccessToken } from './oauth.js';

/**
 * QuickBooks Online adaptor.
 *
 * THE CONNECTION IS REAL NOW. Two things used to make "connected" impossible
 * even with correct credentials:
 *   1. `connect()` checked only that a client id/secret were present, then set
 *      the token to the literal `'stub-token'` — an unusable placeholder
 *      reported as success.
 *   2. The default transport threw (`... stubbed pending credentials`), so no
 *      probe could ever reach Intuit.
 * The transport is now `fetch` (see `httpTransport`), the token comes from
 * `QUICKBOOKS_ACCESS_TOKEN` or a refresh-token exchange (`oauth.ts`), and the
 * health probe asks Intuit for the company record of the configured realm —
 * the cheapest call that proves realm, token and network together.
 *
 * WHAT REMAINS APPROXIMATE: the payment push and the sync pull keep their
 * existing paths. Making those semantically correct (a QuickBooks `Payment`
 * referencing an invoice; the query API for sync state) is separate work from
 * establishing the connection, and is called out here rather than left to look
 * finished.
 */
export class QuickBooksAdaptor implements AccountingAdaptor {
  readonly id: AdaptorId = 'quickbooks';
  readonly name = 'QuickBooks Online';

  private connected = false;
  private oauthToken: string | null = null;
  /**
   * The CURRENT refresh token. Intuit rotates it on every exchange, so the
   * token minted at connect time replaces the configured one for the life of
   * the process — otherwise the second exchange (after an access token expires)
   * would present a spent token and fail. A restart falls back to the env value,
   * which is why the rotated one must also be written back to `.env` if the
   * deployment restarts often enough to matter.
   */
  private refreshToken: string | undefined;
  private readonly transport: AdaptorTransport;

  constructor(transport?: AdaptorTransport) {
    this.transport = transport ?? httpTransport;
  }

  async connect(): Promise<void> {
    const token = await resolveAccessToken(this.transport, {
      clientId: env.QUICKBOOKS_CLIENT_ID,
      clientSecret: env.QUICKBOOKS_CLIENT_SECRET,
      accessToken: env.QUICKBOOKS_ACCESS_TOKEN,
      refreshToken: this.refreshToken ?? env.QUICKBOOKS_REFRESH_TOKEN,
      tokenUrl: INTUIT_TOKEN_URL,
    });
    this.oauthToken = token.accessToken;
    this.refreshToken = token.refreshToken;
    this.connected = true;
    logger.info(
      { adaptor: this.id, realm: env.QUICKBOOKS_REALM_ID ?? null },
      'QuickBooks adaptor connected',
    );
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.oauthToken = null;
    this.refreshToken = undefined;
    logger.info({ adaptor: this.id }, 'QuickBooks adaptor disconnected');
  }

  async status(): Promise<AdaptorStatus> {
    return this.connected ? 'connected' : 'disconnected';
  }

  async pushCompletedPayment(payment: PaymentRef): Promise<PushResult> {
    this.assertConnected();
    const response = await this.request('POST', `/invoice/${payment.externalInvoiceId}/payment`);
    this.assertOk(response, 'QuickBooks push failed');
    return {
      externalRef: payment.transactionId,
      at: new Date().toISOString(),
    };
  }

  async pullSyncStatus(): Promise<SyncResult> {
    this.assertConnected();
    const response = await this.request('GET', '/query?query=select%20count(*)%20from%20Invoice');
    this.assertOk(response, 'QuickBooks sync failed');
    return {
      status: 'ok',
      ranAt: new Date().toISOString(),
      matched: 0,
      unmatched: 0,
      anomalies: 0,
    };
  }

  /**
   * Health probe against the realm's company record.
   *
   * Reports rather than throws (the contract for `healthCheck`), including on a
   * transport failure: the console's service panel reads this, and throwing
   * would only collapse into the same "unreachable" it already shows — without
   * the reason.
   *
   * A 401 means the access token expired (they last about an hour). With a
   * refresh token configured the adaptor mints a new one and retries once, so a
   * long-running container does not silently go dark mid-shift.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    this.assertConnected();
    const started = Date.now();
    try {
      let response = await this.probe();
      if (response.status === 401 && env.QUICKBOOKS_REFRESH_TOKEN) {
        await this.connect();
        response = await this.probe();
      }
      const latencyMs = Date.now() - started;
      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          latencyMs,
          message: `QuickBooks answered ${response.status}${describeResponseError(response)}`,
        };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: err instanceof Error ? err.message : 'QuickBooks health check failed',
      };
    }
  }

  private probe(): Promise<AdaptorResponse> {
    const realm = env.QUICKBOOKS_REALM_ID ?? '';
    return this.request('GET', `/companyinfo/${realm}`);
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
   * Build and send a QuickBooks REST call.
   *
   * QuickBooks addresses every resource through the company (realm) it belongs
   * to: `{base}/v3/company/{realm}/{resource}`. The previous version emitted
   * `{base}/realm/{realm}/...`, which is not a QuickBooks URL at all — it would
   * have 404'd on the first real call.
   */
  private async request(method: HttpMethod, path: string, body?: unknown): Promise<AdaptorResponse> {
    const base = (env.QUICKBOOKS_BASE_URL ?? '').replace(/\/+$/, '');
    const realm = env.QUICKBOOKS_REALM_ID ?? '';
    const fullUrl = `${base}/v3/company/${realm}${path}`;
    const headers: Record<string, string> = this.oauthToken
      ? { Authorization: `Bearer ${this.oauthToken}` }
      : {};
    return this.transport(method, fullUrl, body, headers);
  }
}

/** Pull a short reason out of an error body, when the upstream sent one. */
function describeResponseError(response: AdaptorResponse): string {
  const body = response.body;
  if (body && typeof body === 'object') {
    const fault = (body as Record<string, unknown>)['Fault'];
    if (fault && typeof fault === 'object') {
      const errors = (fault as Record<string, unknown>)['Error'];
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0] as Record<string, unknown>;
        const message = first['Message'] ?? first['Detail'];
        if (typeof message === 'string' && message.trim() !== '') return `: ${message}`;
      }
    }
  }
  return '';
}
