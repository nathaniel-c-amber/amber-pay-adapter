import { PaymentPreflightService } from './paymentPreflight.service.js';
import { ValidationError } from '../../utils/errors.js';
import type {
  AccountingAdaptor,
  CustomerMatchConfig,
  PreflightOutcome,
} from '../../types/adaptor.js';

const match: CustomerMatchConfig = {
  strategy: 'customField',
  mode: 'exact',
  fieldName: 'Student ID',
  depositAccountId: null,
};

const input = {
  organizationId: 'org-1',
  matchValue: 'S1234567',
  amount: '250.00',
  currency: 'JMD',
};

function harness(options: {
  adaptorId?: string | null;
  match?: CustomerMatchConfig | null;
  preflight?: PreflightOutcome | Error;
  hasPreflight?: boolean;
  connected?: boolean;
} = {}) {
  const preflightPayment = jest.fn(async () => {
    if (options.preflight instanceof Error) throw options.preflight;
    return options.preflight ?? { ok: true };
  });
  const connect = jest.fn(async () => undefined);
  const status = jest.fn(async () => (options.connected === false ? 'disconnected' : 'connected'));
  const adaptor = {
    id: 'quickbooks',
    status,
    ...(options.hasPreflight === false ? {} : { preflightPayment }),
  } as unknown as AccountingAdaptor;

  const service = new PaymentPreflightService({
    resolveAdaptorId: async () => (options.adaptorId === undefined ? 'quickbooks' : options.adaptorId) as never,
    resolveMatchConfig: async () => (options.match === undefined ? match : options.match),
    adaptors: { get: () => adaptor },
    connect,
  });
  return { service, preflightPayment, connect, status };
}

describe('PaymentPreflightService', () => {
  it('passes the figure, currency, reference and resolved rule to the adaptor', async () => {
    const { service, preflightPayment } = harness();
    await service.check(input);

    expect(preflightPayment).toHaveBeenCalledWith({
      matchValue: 'S1234567',
      amount: '250.00',
      currency: 'JMD',
      match,
    });
  });

  it('skips when no accounting system is configured', async () => {
    const { service, preflightPayment } = harness({ adaptorId: null });
    await service.check(input);
    expect(preflightPayment).not.toHaveBeenCalled();
  });

  it('skips when no matching rule is configured', async () => {
    const { service, preflightPayment } = harness({ match: null });
    await service.check(input);
    expect(preflightPayment).not.toHaveBeenCalled();
  });

  it('skips when the adaptor cannot pre-flight (Sage)', async () => {
    const { service } = harness({ hasPreflight: false });
    await expect(service.check(input)).resolves.toBeUndefined();
  });

  it('connects a disconnected adaptor before asking', async () => {
    const { service, connect, preflightPayment } = harness({ connected: false });
    await service.check(input);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(preflightPayment).toHaveBeenCalledTimes(1);
  });

  it.each([
    'customer-not-found',
    'customer-ambiguous',
    'invoice-not-found',
    'amount-invalid',
    'amount-exceeds-balance',
    'currency-mismatch',
  ] as const)('BLOCKS a definitive rejection (%s) with a 400 naming the fix', async (reason) => {
    const { service, preflightPayment } = harness({ preflight: { ok: false, reason } });

    const error = await service.check(input).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).statusCode).toBe(400);
    expect(preflightPayment).toHaveBeenCalledTimes(1);
    // No ledger data, no customer name and no echo of the reference.
    const message = (error as ValidationError).message;
    expect(message).not.toContain('250');
    expect(message).not.toContain('S1234567');
  });

  it('ALLOWS the payment when the check itself fails', async () => {
    const { service } = harness({ preflight: new Error('upstream unreachable') });
    await expect(service.check(input)).resolves.toBeUndefined();
  });
});
