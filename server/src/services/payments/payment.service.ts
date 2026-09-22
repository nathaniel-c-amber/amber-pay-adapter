import { randomUUID } from 'node:crypto';
import { amberPayGateway } from '../gateway/amberpay.service.js';
import type { AmberPayGateway, PaymentLinkResult } from '../../types/gateway.js';
import type { PaymentRepository } from '../../types/repository.js';
import type { Payment } from '../../models/domain.js';

export interface CreatePaymentInput {
  invoiceId: string;
  externalInvoiceId: string;
  /** Opaque reference only (no amount / no PII). */
  reference: string;
  organizationId: string;
}

export interface CreatePaymentResult {
  payment: Payment;
  link: PaymentLinkResult;
}

/**
 * Thin payment service (S1): owns the gateway call, Payment entity assembly
 * and persistence. Routes only validate input and dispatch here, keeping
 * business logic out of the HTTP layer.
 */
export class PaymentService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly gateway: AmberPayGateway = amberPayGateway,
  ) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const link = await this.gateway.createPaymentLink({
      invoiceId: input.invoiceId,
      externalInvoiceId: input.externalInvoiceId,
      reference: input.reference,
      status: 'initiated',
    });

    const payment = await this.payments.create({
      id: randomUUID(),
      invoiceId: input.invoiceId,
      organizationId: input.organizationId,
      transactionId: link.reference,
      status: 'initiated',
      processedAt: new Date().toISOString(),
    });

    return { payment, link };
  }

  /** Org-scoped read (C1): returns undefined when the payment is not in the caller's orgs. */
  async findById(id: string, organizationIds: string[] | null): Promise<Payment | undefined> {
    return this.payments.findById(id, organizationIds);
  }
}