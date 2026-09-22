import {
  Account,
  Invoice,
  Payment,
  ReconciliationJob,
  LifecycleEvent,
  ConnectorState,
  Failure,
  PolicyScope,
} from './domain.js';
import type {
  PaymentRef,
  SyncResult,
  PushResult,
  HealthCheckResult,
  AdaptorStatus,
} from '../types/adaptor.js';

// Keys that must never appear on operational/monitoring domain types.
// NOTE: `User` is intentionally excluded — it is an auth entity whose `email`
// is the invite email (allowed) and `hashedPassword` is a credential hash.
const FORBIDDEN_KEYS = [
  'amount',
  'currency',
  'card',
  'cardNumber',
  'customer',
  'email',
  'ssn',
  'iban',
  'accountNumber',
  'balance',
  'total',
  'price',
  'value',
];

function collectKeys(...objects: object[]): string[] {
  return objects.flatMap((obj) => Object.keys(obj));
}

describe('privacy constraint', () => {
  it('operational/monitoring domain types expose no sensitive keys', () => {
    const account: Account = {
      id: 'a1',
      name: 'Ledger',
      organizationId: 'org1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const invoice: Invoice = {
      id: 'i1',
      accountId: 'a1',
      organizationId: 'org1',
      externalInvoiceId: 'ref-1',
      status: 'open',
      dueDate: '2026-01-01T00:00:00.000Z',
    };
    const payment: Payment = {
      id: 'p1',
      invoiceId: 'i1',
      organizationId: 'org1',
      transactionId: 'tx-1',
      status: 'collected',
      processedAt: '2026-01-01T00:00:00.000Z',
    };
    const reconciliation: ReconciliationJob = {
      id: 'r1',
      organizationId: 'org1',
      runAt: '2026-01-01T00:00:00.000Z',
      status: 'completed',
      summary: {
        status: 'ok',
        matched: 1,
        unmatched: 0,
        anomalies: 0,
        ranAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const event: LifecycleEvent = {
      id: 'e1',
      organizationId: 'org1',
      at: '2026-01-01T00:00:00.000Z',
      type: 'initiated',
      channel: 'payment',
      ref: 'ref-1',
      detail: 'ok',
    };
    const connector: ConnectorState = {
      id: 'c1',
      organizationId: 'org1',
      label: 'QB',
      terminus: 'quickbooks',
      status: 'open',
      reading: 'ok',
      note: 'ok',
    };
    const failure: Failure = {
      id: 'f1',
      organizationId: 'org1',
      severity: 'critical',
      channel: 'webhook',
      title: 'err',
      detail: 'err',
      since: '2026-01-01T00:00:00.000Z',
    };
    const policy: PolicyScope = {
      id: 'p1',
      label: 'scope',
      attributes: {},
      readOnly: true,
    };

    const keys = collectKeys(
      account,
      invoice,
      payment,
      reconciliation,
      event,
      connector,
      failure,
      policy,
    );
    const forbidden = keys.filter((key) => FORBIDDEN_KEYS.includes(key));
    expect(forbidden).toEqual([]);
  });

  it('adaptor types expose no sensitive keys', () => {
    const paymentRef: PaymentRef = {
      id: 'p1',
      transactionId: 'tx-1',
      externalInvoiceId: 'inv-1',
      status: 'collected',
      processedAt: '2026-01-01T00:00:00.000Z',
    };
    const syncResult: SyncResult = {
      status: 'ok',
      ranAt: '2026-01-01T00:00:00.000Z',
      matched: 0,
      unmatched: 0,
      anomalies: 0,
    };
    const pushResult: PushResult = {
      externalRef: 'tx-1',
      at: '2026-01-01T00:00:00.000Z',
    };
    const healthCheck: HealthCheckResult = {
      ok: true,
      latencyMs: 1,
    };

    const keys = collectKeys(paymentRef, syncResult, pushResult, healthCheck);
    const forbidden = keys.filter((key) => FORBIDDEN_KEYS.includes(key));
    expect(forbidden).toEqual([]);

    // AdaptorStatus is a string union; assert its members are operational only.
    const statuses: AdaptorStatus[] = ['connected', 'disconnected', 'error', 'syncing'];
    const forbiddenStatuses = statuses.filter((status) => FORBIDDEN_KEYS.includes(status));
    expect(forbiddenStatuses).toEqual([]);
  });
});
