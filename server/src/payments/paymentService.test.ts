import { PaymentService } from './paymentService.js';
import { createInMemoryRepositories } from '../repositories/inMemory.js';
import type { AmberPayGateway, PaymentLinkResult } from '../gateway/types.js';

function stubGateway(): AmberPayGateway {
  return {
    async createPaymentLink(): Promise<PaymentLinkResult> {
      return {
        linkUrl: 'https://amberpay.example.com/pay/ref-0001',
        reference: 'ref-0001',
        expiresAt: '2026-01-02T00:00:00.000Z',
      };
    },
    verifyWebhookSignature: () => false,
    parseWebhook: () => {
      throw new Error('not used');
    },
  };
}

describe('PaymentService', () => {
  it('assembles and persists an org-scoped payment from the gateway link', async () => {
    const repositories = createInMemoryRepositories();
    const service = new PaymentService(repositories.payments, stubGateway());

    const { payment, link } = await service.createPayment({
      invoiceId: 'inv-1',
      externalInvoiceId: 'ext-1',
      reference: 'ref-0001',
      organizationId: 'org-1',
    });

    expect(payment.status).toBe('initiated');
    expect(payment.transactionId).toBe('ref-0001');
    expect(payment.organizationId).toBe('org-1');
    expect(typeof link.linkUrl).toBe('string');
    expect(link.reference).toBe('ref-0001');

    const stored = await repositories.payments.findById(payment.id, ['org-1']);
    expect(stored?.id).toBe(payment.id);
  });

  it('findById returns undefined for a payment outside the caller orgs (C1)', async () => {
    const repositories = createInMemoryRepositories();
    const service = new PaymentService(repositories.payments, stubGateway());

    const { payment } = await service.createPayment({
      invoiceId: 'inv-1',
      externalInvoiceId: 'ext-1',
      reference: 'ref-0001',
      organizationId: 'org-2',
    });

    await expect(service.findById(payment.id, ['org-1'])).resolves.toBeUndefined();
    await expect(service.findById(payment.id, ['org-2'])).resolves.toBeDefined();
  });
});