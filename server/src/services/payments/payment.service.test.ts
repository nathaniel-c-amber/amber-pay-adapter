import { PaymentService } from './payment.service.js';
import { createInMemoryRepositories } from '../../repositories/inMemory.js';
import { CheckoutService } from '../gateway/checkout.service.js';
import { ValidationError } from '../../utils/errors.js';
import type { CheckoutIntentStore } from '../gateway/checkout.service.js';
import type { AdaptorResponse, HttpMethod } from '../../types/adaptor.js';

/**
 * A checkout that reaches no gateway and no database.
 *
 * The service's job is now to VALIDATE and to assemble, and both are invisible
 * against a real checkout: a bad student id would surface through the signature
 * call's side effects rather than at the boundary. So the collaborator is
 * replaced outright.
 */
function stubCheckout(): CheckoutService {
  return new CheckoutService(
    {
      async create() {
        /* nothing to store */
      },
      async findByTransactionId() {
        return undefined;
      },
    } satisfies CheckoutIntentStore,
    (async (_method: HttpMethod, _url: string): Promise<AdaptorResponse> => ({
      status: 200,
      body: { success: 'Y', Signature: 'c2ln' },
    })) as never,
    () => 'ABCDEFGH1234',
  );
}

const input = {
  invoiceId: 'inv-1',
  studentId: 'STU0026',
  amountMinorUnits: 25000,
  currency: 'JMD' as const,
  organizationId: 'org-1',
};

describe('PaymentService', () => {
  it('stores the transaction id the checkout minted, not an id of its own', async () => {
    const repositories = createInMemoryRepositories();
    const service = new PaymentService(repositories.payments, stubCheckout());

    const { payment, session } = await service.createPayment(input);

    // The gateway echoes THIS value on the callback; it is the only link between
    // an incoming payment and our record. An id of our own would attribute
    // nothing.
    expect(payment.transactionId).toBe('ABCDEFGH1234');
    expect(payment.transactionId).toBe(session.transactionId);
    expect(payment.status).toBe('initiated');
    expect(payment.organizationId).toBe('org-1');

    const stored = await repositories.payments.findById(payment.id, ['org-1']);
    expect(stored?.id).toBe(payment.id);
  });

  it('never attaches a figure to the entity it keeps', async () => {
    const repositories = createInMemoryRepositories();
    const service = new PaymentService(repositories.payments, stubCheckout());

    const { payment, session } = await service.createPayment(input);

    // The figure goes out to the browser inside the checkout, once. Not on the
    // entity, not in any event, not in a log line.
    expect(session.params.Amount).toBe(25000);
    expect(Object.keys(payment).map((k) => k.toLowerCase())).not.toContain('amount');
    expect(JSON.stringify(payment)).not.toContain('25000');
  });

  it('refuses a customer identifier it could not match on', async () => {
    const repositories = createInMemoryRepositories();
    const service = new PaymentService(repositories.payments, stubCheckout());

    // Validated here rather than left to fail later inside a query against the
    // organization's books, where the operator could not see which field was
    // wrong.
    await expect(
      service.createPayment({ ...input, studentId: 'student@example.com' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(service.createPayment({ ...input, studentId: 'ab' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('refuses a currency the gateway does not document', async () => {
    const repositories = createInMemoryRepositories();
    const service = new PaymentService(repositories.payments, stubCheckout());

    await expect(service.createPayment({ ...input, currency: 'EUR' as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('refuses a fractional or non-positive figure before it reaches a signature', async () => {
    const repositories = createInMemoryRepositories();
    const service = new PaymentService(repositories.payments, stubCheckout());

    // A rounded figure produces a signature the gateway rejects — or, worse,
    // accepts for a different sum.
    await expect(service.createPayment({ ...input, amountMinorUnits: 10.5 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.createPayment({ ...input, amountMinorUnits: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('findById returns undefined for a payment outside the caller orgs (C1)', async () => {
    const repositories = createInMemoryRepositories();
    const service = new PaymentService(repositories.payments, stubCheckout());

    const { payment } = await service.createPayment({ ...input, organizationId: 'org-2' });

    await expect(service.findById(payment.id, ['org-1'])).resolves.toBeUndefined();
    await expect(service.findById(payment.id, ['org-2'])).resolves.toBeDefined();
  });
});