import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { ValidationError } from '../../utils/errors.js';
import { GATEWAY_CURRENCIES, STUDENT_ID } from '../gateway/amberPayWire.js';
import { CheckoutService } from '../gateway/checkout.service.js';
import { getPool } from '../../db/pool.js';
import { PostgresCheckoutIntentStore } from '../../repositories/postgres.js';
import type { PaymentRepository } from '../../types/repository.js';
import type { Payment } from '../../models/domain.js';
import type { CheckoutSession, GatewayCurrency } from '../gateway/amberPayWire.js';

export interface CreatePaymentInput {
  invoiceId: string;
  organizationId: string;
  /**
   * The customer this payment is for — the organization's own identifier, e.g.
   * `STU0026`.
   *
   * IT IS NOT THE GATEWAY'S `externalInvoiceId`. That field was an accounting
   * invoice reference wearing a name that said "external", and it was never what
   * a checkout needs. What a checkout needs is WHO is paying, because the gateway
   * echoes it back and that echo is how a callback is attributed. Removed rather
   * than renamed, because the old value was never an invoice id in any sense and
   * keeping the name would have kept the lie.
   */
  studentId: string;
  /** MINOR UNITS — 25000 is 250.00, which is the gateway's own convention. */
  amountMinorUnits: number;
  currency: GatewayCurrency;
}

export interface CreatePaymentResult {
  payment: Payment;
  session: CheckoutSession;
}

/**
 * Payment service: owns the checkout, the Payment entity, and persistence.
 * Routes only validate input and dispatch here.
 *
 * ★ THE FIGURE NEVER REACHES THE DOMAIN. `Payment` has no amount field and
 * never will — that is FR-2.3, enforced by `privacy.test.ts`. The checkout
 * needs a figure, so it travels inside `CheckoutSession` and goes straight back
 * to the browser: never attached to the entity, never persisted on it, never
 * written into an event or a log line.
 */
export class PaymentService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly checkout: CheckoutService = new CheckoutService(
      new PostgresCheckoutIntentStore(getPool()),
    ),
  ) {}

  /**
   * Create a checkout for one customer.
   *
   * The checkout is created FIRST and the entity second, and the order is forced
   * rather than chosen: the checkout mints the transaction id, the gateway echoes
   * it on the callback, and the entity stores it — so an entity created first
   * would have nothing to store.
   */
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!STUDENT_ID.test(input.studentId)) {
      throw new ValidationError(
        'studentId must be an opaque identifier — letters, digits, hyphens and underscores',
      );
    }
    if (!(GATEWAY_CURRENCIES as readonly string[]).includes(input.currency)) {
      throw new ValidationError(`currency must be one of ${GATEWAY_CURRENCIES.join(', ')}`);
    }

    const session = await this.checkout.create({
      organizationId: input.organizationId,
      studentId: input.studentId,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      clientId: env.AMBER_PAY_CLIENT_ID,
    });

    const payment = await this.payments.create({
      id: randomUUID(),
      invoiceId: input.invoiceId,
      organizationId: input.organizationId,
      // The transaction id WE minted, which the gateway will echo. Not the
      // entity's own uuid: it has to be the value the callback arrives with.
      transactionId: session.transactionId,
      status: 'initiated',
      processedAt: new Date().toISOString(),
    });

    return { payment, session };
  }

  /** Org-scoped read (C1): undefined when the payment is not in the caller's orgs. */
  async findById(id: string, organizationIds: string[] | null): Promise<Payment | undefined> {
    return this.payments.findById(id, organizationIds);
  }
}