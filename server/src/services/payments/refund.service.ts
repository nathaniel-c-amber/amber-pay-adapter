/* Refunding a collected payment, and correcting the books afterwards.
 *
 * ★ THE ORDER IS THE CONTRACT, AND IT CANNOT BE REARRANGED.
 *
 *   1. CHECK    the payment is collected, and the caller meant THIS payment
 *   2. VERIFY   the amount against the original charge we sealed at checkout
 *   3. REFUND   the gateway, once
 *   4. RECORD   the payment is refunded, and the lifecycle event says so
 *   5. REVERSE  correct the accounting record
 *
 * Steps 3 and 4 are in that order because the local status is a claim about what
 * the provider did: writing `refunded` before the provider accepts would leave a
 * payment marked refunded whose money never moved, and the provider permits only
 * one refund so there is no second attempt to put it right. Step 5 is last
 * because a bookkeeping failure must never look like a refund failure — by then
 * the money HAS gone back, and the only honest thing left is to report that the
 * ledger still shows the payment.
 *
 * Nothing before step 3 changes any state, so a gateway refusal leaves the
 * payment exactly as it was.
 */

import { logger } from '../../utils/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { toMinorUnits } from '../../utils/money.js';
import { openExpectedCharge } from '../gateway/amberPayWire.js';
import { defaultGatewayRefund } from '../gateway/refund.service.js';
import { connectAdaptor } from '../adaptors/credentials.provider.js';
import { resolveConfiguredAdaptorId } from '../adaptors/activeAdaptor.service.js';
import { adaptorRegistry } from '../adaptors/registry.js';
import { eventLog } from '../events/eventLog.service.js';
import { failureTracker } from '../events/failureTracker.service.js';
import { getPool } from '../../db/pool.js';
import { PostgresCheckoutIntentStore } from '../../repositories/postgres.js';
import type { AccountingAdaptor, AdaptorId } from '../../types/adaptor.js';
import type { Payment } from '../../models/domain.js';
import type { PaymentRepository } from '../../types/repository.js';
import type { GatewayRefundInput } from '../gateway/refund.service.js';
import type { EventLog } from '../events/eventLog.service.js';
import type { FailureTracker } from '../events/failureTracker.service.js';

export interface RefundInput {
  /** How much to return, in major units. Absent means the full original charge. */
  amount?: string;
  /**
   * The operator's proof that they meant this payment: the transaction id,
   * typed exactly. A confirmation that is merely present is not confirmation.
   */
  confirmation: string;
}

/** What the caller is told about the accounting correction. */
export interface RefundOutcome {
  scope: 'full' | 'partial';
  accountingReversal:
    | 'reversed'
    | 'manual-adjustment-required'
    | 'failed'
    | 'not-configured';
  /** Present when the books still need a person. Never contains a figure. */
  message?: string;
}

export interface RefundResult {
  payment: Payment;
  refund: RefundOutcome;
}

/** The one read a refund needs from the sealed checkout record. */
export interface RefundChargeStore {
  findExpectedChargeByTransactionId(
    organizationId: string,
    transactionId: string,
  ): Promise<{ expectedSealed: Buffer } | undefined>;
}

export interface RefundServiceDeps {
  payments: PaymentRepository;
  intents?: RefundChargeStore;
  gateway?: (input: GatewayRefundInput) => Promise<void>;
  events?: Pick<EventLog, 'recordEvent'>;
  failures?: Pick<FailureTracker, 'recordFailure'>;
  resolveAdaptorId?: () => Promise<AdaptorId | null>;
  adaptors?: { get(id: AdaptorId): AccountingAdaptor };
  connect?: (adaptor: AccountingAdaptor) => Promise<void>;
}

const MANUAL_PARTIAL =
  'The payment was partially refunded. The accounting system still shows the full payment, so it must be adjusted by hand.';
const REVERSAL_FAILED =
  'MONEY REFUNDED, but the accounting system still shows this payment. The accounting record must be reversed by hand.';

export class RefundService {
  private readonly intents: RefundChargeStore;
  private readonly gateway: (input: GatewayRefundInput) => Promise<void>;
  private readonly events: Pick<EventLog, 'recordEvent'>;
  private readonly failures: Pick<FailureTracker, 'recordFailure'>;

  constructor(private readonly deps: RefundServiceDeps) {
    this.intents = deps.intents ?? new PostgresCheckoutIntentStore(getPool());
    this.gateway = deps.gateway ?? defaultGatewayRefund;
    this.events = deps.events ?? eventLog;
    this.failures = deps.failures ?? failureTracker;
  }

  async refundPayment(
    paymentId: string,
    input: RefundInput,
    organizationIds: string[] | null,
  ): Promise<RefundResult> {
    const payment = await this.deps.payments.findById(paymentId, organizationIds);
    if (!payment) {
      throw new NotFoundError('Payment not found');
    }

    if (payment.status === 'refunded') {
      throw new ConflictError('This payment has already been refunded');
    }
    if (payment.status !== 'collected') {
      throw new ConflictError('Only a collected payment can be refunded');
    }
    if (input.confirmation !== payment.transactionId) {
      throw new ValidationError(
        'confirmation must exactly match the payment transaction id',
      );
    }

    const { originalAmount, currency } = await this.originalCharge(payment);
    const originalMinor = toMinorUnits(originalAmount);
    if (originalMinor === null || originalMinor <= 0) {
      throw new ValidationError('The original charge for this payment is not a usable figure');
    }

    const refundAmount = input.amount ?? originalAmount;
    const refundMinor = toMinorUnits(refundAmount);
    if (refundMinor === null || refundMinor <= 0) {
      throw new ValidationError(
        'amount must be a positive decimal figure in major units with at most two decimal places',
      );
    }
    if (refundMinor > originalMinor) {
      throw new ValidationError('The refund amount cannot exceed the original amount');
    }

    /*
      ★ NO STATE HAS CHANGED YET. A throw here leaves the payment collected and
      the books untouched, which is the only safe outcome: the provider has not
      been asked, so there is nothing to undo.
    */
    await this.gateway({
      transactionId: payment.transactionId,
      originalAmount,
      currency,
      refundAmount,
    });

    const refunded =
      (await this.deps.payments.updateStatus(payment.id, 'refunded')) ?? {
        ...payment,
        status: 'refunded',
      };

    /*
      ONE event, written after the money moved. It carries no figure: the amount
      is a fact about the refund the gateway holds, and the lifecycle log is
      explicitly not a place for financial data.
    */
    /*
      The event log is a claim ABOUT the refund, not the refund. A failure to
      write it must never skip step 5, because that would leave the books
      showing a payment whose money has already gone back — the exact state
      the reversal exists to prevent.
    */
    try {
      await this.events.recordEvent({
        type: 'payment-refunded',
        channel: 'payment',
        ref: payment.transactionId,
        detail: 'Payment refunded',
        organizationId: payment.organizationId,
      });
    } catch (err) {
      logger.error(
        { payment: payment.id, err },
        'Payment refunded but the lifecycle event could not be recorded',
      );
    }

    const scope = refundMinor === originalMinor ? 'full' : 'partial';
    const refund = await this.reverse(payment, originalAmount, refundAmount, scope);

    logger.info(
      { payment: payment.id, scope, reversal: refund.accountingReversal },
      'Refund completed',
    );
    return { payment: refunded, refund };
  }

  /**
   * The original amount and currency, opened from the sealed checkout record.
   *
   * The figure must come from what WE asked the customer to pay, never from a
   * request body: it is both the signature input and the ceiling on the refund.
   */
  private async originalCharge(
    payment: Payment,
  ): Promise<{ originalAmount: string; currency: ReturnType<typeof openExpectedCharge>['currency'] }> {
    const row = await this.intents.findExpectedChargeByTransactionId(
      payment.organizationId,
      payment.transactionId,
    );
    if (!row) {
      throw new ConflictError(
        'The original charge for this payment is not recorded, so a refund cannot be validated',
      );
    }
    const charge = openExpectedCharge(row.expectedSealed);
    return { originalAmount: charge.amount, currency: charge.currency };
  }

  /**
   * Correct accounting AFTER the refund. Never throws: the money has already
   * gone back, and turning a bookkeeping problem into a failed refund would
   * invite a second attempt the provider would refuse — or worse, duplicate.
   */
  private async reverse(
    payment: Payment,
    originalAmount: string,
    refundAmount: string,
    scope: 'full' | 'partial',
  ): Promise<RefundOutcome> {
    let adaptorId: AdaptorId | null = null;
    try {
      adaptorId = await (this.deps.resolveAdaptorId ?? resolveConfiguredAdaptorId)();
      if (!adaptorId) return { scope, accountingReversal: 'not-configured' };

      const adaptor = (this.deps.adaptors ?? adaptorRegistry).get(adaptorId);
      if (!adaptor.reverseCompletedPayment) {
        return { scope, accountingReversal: 'not-configured' };
      }
      if ((await adaptor.status()) !== 'connected') {
        await (this.deps.connect ?? connectAdaptor)(adaptor);
      }

      const outcome = await adaptor.reverseCompletedPayment({
        transactionId: payment.transactionId,
        originalAmount,
        refundAmount,
      });
      if (outcome.status === 'reversed') {
        return { scope, accountingReversal: 'reversed' };
      }

      await this.recordFinding(
        payment.organizationId,
        'Refunded payment needs a manual accounting adjustment',
        MANUAL_PARTIAL,
      );
      return {
        scope,
        accountingReversal: 'manual-adjustment-required',
        message: MANUAL_PARTIAL,
      };
    } catch (err) {
      logger.error(
        { adaptor: adaptorId, payment: payment.id, err },
        'Refund succeeded but the accounting reversal failed',
      );
      await this.recordFinding(
        payment.organizationId,
        'Payment refunded but the accounting record could not be reversed',
        REVERSAL_FAILED,
      );
      return { scope, accountingReversal: 'failed', message: REVERSAL_FAILED };
    }
  }

  /** A critical finding, with text that never names a figure or a person. */
  private async recordFinding(
    organizationId: string,
    title: string,
    detail: string,
  ): Promise<void> {
    await this.failures.recordFailure({
      severity: 'critical',
      channel: 'accounting',
      title,
      detail,
      organizationId,
    });
  }
}
