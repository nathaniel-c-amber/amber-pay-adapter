import { PaymentService } from './payment.service.js';
import { createInMemoryRepositories } from '../../repositories/inMemory.js';
import { ValidationError } from '../../utils/errors.js';
import type { CheckoutService } from '../gateway/checkout.service.js';

const input = {
  invoiceId: 'inv-1',
  studentId: 'STU0026',
  amount: '250.00',
  currency: 'JMD' as const,
  organizationId: 'org-1',
};

function checkout() {
  return {
    create: jest.fn(async () => ({
      checkoutUrl: 'https://gateway.test/gateway/v1/standard-checkout',
      params: {},
      transactionId: 'ABCDEFGH1234',
      statusToken: 'tok',
    })),
  } as unknown as CheckoutService;
}

describe('PaymentService pre-flight', () => {
  it('asks before minting a checkout, with the customer and the figure', async () => {
    const repositories = createInMemoryRepositories();
    const preflight = jest.fn(async () => undefined);
    const gateway = checkout();
    const service = new PaymentService(repositories.payments, gateway, preflight);

    await service.createPayment(input);

    expect(preflight).toHaveBeenCalledWith({
      organizationId: 'org-1',
      matchValue: 'STU0026',
      amount: '250.00',
      currency: 'JMD',
    });
    expect(gateway.create).toHaveBeenCalledTimes(1);
  });

  it('does NOT mint a checkout or store a payment when pre-flight blocks', async () => {
    const repositories = createInMemoryRepositories();
    const create = jest.spyOn(repositories.payments, 'create');
    const gateway = checkout();
    const service = new PaymentService(
      repositories.payments,
      gateway,
      async () => {
        throw new ValidationError('blocked by the ledger');
      },
    );

    await expect(service.createPayment(input)).rejects.toBeInstanceOf(ValidationError);
    expect(gateway.create).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
