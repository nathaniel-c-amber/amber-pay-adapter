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
      invoiceRef: 'inv-1',
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
      'invoiceRef',
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

    /** Interfaces that legitimately carry a figure, all in the wire file. */
    const ALLOWED = new Set([
      'QboInvoice',
      'QboPaymentLine',
      'QboPaymentRequest',
      'QboPaymentCreated',
    ]);

    /** Spelled the way the accounting API spells them, plus the local casing. */
    const MONEY_FIELD = /\b(TotalAmt|Balance|UnappliedAmt|Amount)\b\s*[?]?\s*:/;

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

    it('declares no money field outside quickbooksWire.ts', () => {
      const offenders: string[] = [];
      for (const file of serverSourceFiles(serverRoot)) {
        const source = readFileSync(file, 'utf8');
        // Strip comments: a comment may DISCUSS a figure without holding one,
        // and `quickbooksWire.ts` is mostly commentary about these very names.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        // Each interface body is scanned in isolation, so one allowed interface
        // cannot lend its fields to a neighbour that happens to follow it.
        for (const match of code.matchAll(
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

    it('finds the wire file itself, so the scan is proven to work', () => {
      /*
        A test that scans for a violation nothing can violate passes forever. It
        would also have passed if the file walk silently found zero files, or if
        the money fields were renamed. This asserts the positive: the interfaces
        that DO carry a figure are found by the same code, at the same size.
      */
      const wire = readFileSync(join(serverRoot, 'src/services/adaptors/quickbooksWire.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const declared = [...wire.matchAll(/(?:export\s+)?interface\s+([A-Za-z0-9_]+)/g)].map(
        ([, name]) => name,
      );
      for (const allowed of ALLOWED) {
        expect(declared).toContain(allowed);
      }
      const moneyBearing = declared.filter((name) =>
        MONEY_FIELD.test(
          wire.match(new RegExp(`interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '',
        ),
      );
      expect(new Set(moneyBearing)).toEqual(ALLOWED);
    });
  });
});
