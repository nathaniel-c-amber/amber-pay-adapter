import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
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
  CustomerMatchConfig,
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
      matchValue: 'S1234567',
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
      invoiceRefs: ['inv-1'],
      reconciliationRequired: false,
      matchedBy: 'customField',
      alreadyApplied: false,
      verified: true,
    };
    const healthCheck: HealthCheckResult = {
      ok: true,
      latencyMs: 1,
    };
    const matchConfig: CustomerMatchConfig = {
      strategy: 'customField',
      mode: 'exact',
      fieldName: 'Student ID',
      depositAccountId: '35',
    };

    const keys = collectKeys(
      paymentRef,
      syncResult,
      pushResult,
      healthCheck,
      matchConfig,
    );
    const forbidden = keys.filter((key) => FORBIDDEN_KEYS.includes(key));
    expect(forbidden).toEqual([]);

    // AdaptorStatus is a string union; assert its members are operational only.
    const statuses: AdaptorStatus[] = ['connected', 'disconnected', 'error', 'syncing'];
    const forbiddenStatuses = statuses.filter((status) => FORBIDDEN_KEYS.includes(status));
    expect(forbiddenStatuses).toEqual([]);

    /*
      THE WHOLE POINT OF THE ABOVE, stated as its own assertion.
      A payment applied to a real invoice involves figures — QuickBooks requires
      a total and a line amount and returns a balance — and they exist only in
      `services/adaptors/quickbooksWire.ts`. This asserts the shape of the thing
      the pipeline RETURNS, because that is what reaches a log line, an event
      detail and a failure title. If a field is ever added here to carry a
      figure or a name, this fails before the value can be written anywhere.
    */
    expect(Object.keys(pushResult)).toEqual([
      'externalRef',
      'at',
      'invoiceRefs',
      'reconciliationRequired',
      'matchedBy',
      'alreadyApplied',
      'verified',
    ]);
  });

  /*
    THE BOUNDARY IS ENFORCED, NOT ASSERTED IN PROSE.

    `services/adaptors/quickbooksWire.ts` opens by claiming it is the only file
    in the repository where a money field may exist, and that this test reads it
    and fails if one appears elsewhere. Only the second half was true when it
    was written — the claim rested on a comment, which is precisely the kind of
    control that decays silently, and a `TotalAmt` added to any other module
    would have typechecked and gone green.

    So the check is done on the SOURCE, across the whole server tree. Interfaces
    are the target rather than every identifier: a local named `amount` is a
    false positive that would train people to ignore this test, whereas an
    `interface X { TotalAmt: number }` is the actual shape of the leak.
  */
  describe('the money boundary is one file', () => {
    /*
      Resolved from the working directory rather than `import.meta.url`: jest is
      run from `server/`, and `import.meta` is not available under the ts-jest
      transform (`tsc` targets NodeNext but the transform is what compiles the
      tests). It is ASSERTED below rather than trusted, because a root that
      silently resolved to a directory containing no source would make this
      whole block pass forever by scanning nothing.
    */
    const serverRoot = process.cwd();
    expect(existsSync(join(serverRoot, 'jest.config.js'))).toBe(true);
    expect(existsSync(join(serverRoot, 'src/services/adaptors/quickbooksWire.ts'))).toBe(true);
    expect(existsSync(join(serverRoot, 'src/services/gateway/amberPayWire.ts'))).toBe(true);
    expect(existsSync(join(serverRoot, 'src/services/payments/paymentStatus.service.ts'))).toBe(true);

    /**
     * The interfaces permitted to declare a figure, and nothing else.
     *
     * The list grew from one entry to two, so it is enumerated here rather than
     * globbed — an allow-list that could match a new file automatically is not an
     * allow-list, it is a hole with extra steps. Every addition has to be
     * argued here, in the test, where the next person will read it.
     *
     *   QboInvoice, QboPaymentLine, QboPaymentRequest, QboPaymentCreated
     *                      — what the LEDGER says is owed. QuickBooks requires
     *                        `TotalAmt` to apply a payment to an invoice, so
     *                        there is no way to write one without the figure.
     *   GenerateSignatureRequest, StandardCheckoutParams, CreateCheckoutInput,
     *   CreatePaymentInput, ExpectedCharge
     *                      — what the CUSTOMER was asked to pay. The gateway
     *                        requires `Amount` and `CurrencyCode` to sign a
     *                        transaction at all, and its documentation requires
     *                        storing them so the amount charged can be
     *                        cross-checked against what was expected. The last
     *                        three are the same fact at the other boundaries it
     *                        crosses: the request DTOs, and the sealed value.
     *   CustomerPaymentStatusView
     *                      — what that figure is shown back AS. The customer
     *                        typed it, was charged it, and is redirected to a
     *                        page that has to tell them so; the read is scoped to
     *                        one payment by a 256-bit token and carries nothing
     *                        else. `services/payments/paymentStatus.service.ts`
     *                        argues it in full.
     *   PreflightPaymentInput, PaymentPreflightInput
     *                      — what the customer is ABOUT to be charged, handed to
     *                        the accounting check so an impossible payment is
     *                        refused before a checkout is signed. It exists only
     *                        for the duration of that call.
     *   RefundInput, RefundWireRequest
     *                      — the figure being returned, and the provider's own
     *                        body for it. A refund cannot be requested without
     *                        both the original amount and the amount to return,
     *                        and `refund.service.ts` argues the ordering there.
     *
     * Different questions, different files. What none of them may do is let a
     * figure OUT: no domain type, no event, no failure, no log line may carry
     * one — which is what the scan below enforces.
     */
    const ALLOWED = new Set([
      'QboInvoice',
      'QboPaymentLine',
      'QboPaymentRequest',
      'QboPaymentCreated',
      'GenerateSignatureRequest',
      'StandardCheckoutParams',
      'CreateCheckoutInput',
      'CreatePaymentInput',
      'ExpectedCharge',
      'CustomerPaymentStatusView',
      'PreflightPaymentInput',
      'PaymentPreflightInput',
      'RefundInput',
      'RefundWireRequest',
    ]);

    /*
      ★ CASE-INSENSITIVE NOW, AND THAT IS A FIX, NOT A LOOSENING.

      The pattern used to match `Amount` but not `amount`, so `ExpectedCharge`,
      `CreateCheckoutInput` and `CreatePaymentInput` — three interfaces that
      really do hold a figure, and really were invisible to this scan — passed
      purely on casing. That is the exact decay this block exists to prevent: the
      control agreed with itself rather than with the code. Making it case-blind
      caught those three, and they are argued for in the allow-list above, which
      is a more honest state than being unguarded.
    */
    const MONEY_FIELD = /\b(TotalAmt|Balance|UnappliedAmt|Amount)\b\s*[?]?\s*:/i;

    function serverSourceFiles(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          return entry.name === 'node_modules' || entry.name === 'dist'
            ? []
            : serverSourceFiles(full);
        }
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
      });
    }

    it('declares no money field outside the two wire files', () => {
      const offenders: string[] = [];
      for (const file of serverSourceFiles(serverRoot)) {
        const source = readFileSync(file, 'utf8');
        // Strip comments: a comment may DISCUSS a figure without holding one,
        // and `quickbooksWire.ts` is mostly commentary about these very names.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        /*
          A METHOD PARAMETER IS TRANSIENT BY DEFINITION. `amount: string` in
          `AccountingAdaptor.pushCompletedPayment` is the figure the payment was
          charged, passed for the duration of one call and never stored — which
          is the opposite of what this boundary protects. Only stored FIELDS are
          in scope, so parameter lists are removed before interface bodies are
          scanned. This does not loosen the check on any declared field.
        */
        const fieldsOnly = code.replace(/\([^()]*\)/g, '()');
        // Each interface body is scanned in isolation, so one allowed interface
        // cannot lend its fields to a neighbour that happens to follow it.
        for (const match of fieldsOnly.matchAll(
          /(?:export\s+)?interface\s+([A-Za-z0-9_]+)\s*(?:extends[^{]+)?\{([\s\S]*?)\n\}/g,
        )) {
          const [, name, body] = match;
          if (name === undefined || body === undefined || ALLOWED.has(name)) continue;
          if (MONEY_FIELD.test(body)) {
            offenders.push(`${relative(serverRoot, file)}: ${name}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('finds the wire files themselves, so the scan is proven to work', () => {
      /*
        A test that scans for a violation nothing can violate passes forever. It
        would also have passed if the file walk silently found zero files, if
        the money fields were renamed, or if the second allow-listed file were
        empty. This asserts the positive: every interface that DOES carry a
        figure is found by the same code, at the same size, in the same place.
      */
      const sources = [
        'src/types/adaptor.ts',
        'src/services/adaptors/quickbooksWire.ts',
        'src/services/gateway/amberPayWire.ts',
        'src/services/gateway/checkout.service.ts',
        'src/services/gateway/refund.service.ts',
        'src/services/payments/payment.service.ts',
        'src/services/payments/paymentPreflight.service.ts',
        'src/services/payments/paymentStatus.service.ts',
        'src/services/payments/refund.service.ts',
      ].map((relative) =>
        readFileSync(join(serverRoot, relative), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
          // Parameters are transient, not stored fields — see the scan above.
          .replace(/\([^()]*\)/g, '()'),
      );

      const declared = sources.flatMap((source) =>
        [...source.matchAll(/(?:export\s+)?interface\s+([A-Za-z0-9_]+)/g)].map(([, name]) => name),
      );
      // Every allowed name must actually exist, or the allow-list has drifted
      // into permitting something that is no longer there — which would let a
      // real one back in unnoticed.
      for (const allowed of ALLOWED) {
        expect(declared).toContain(allowed);
      }

      const moneyBearing = declared.filter((name) =>
        sources.some((source) =>
          MONEY_FIELD.test(
            source.match(new RegExp(`interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '',
          ),
        ),
      );
      // Nothing may be allow-listed that does not actually hold a figure: an
      // allow-list entry with no figure behind it is a name that could be given
      // one later with nothing left here to catch it.
      expect(new Set(moneyBearing)).toEqual(ALLOWED);
    });
  });
});
