/* Refusing a checkout that the accounting record has already made impossible.
 *
 * A payment that cannot be applied to a ledger is still a payment: the card is
 * charged, and the failure is discovered later as a critical finding and a
 * customer who has to be refunded. This check answers the same three questions
 * the push will answer — who is this, what is outstanding, does the figure fit —
 * BEFORE the checkout is signed, so the customer is told what to fix instead.
 *
 * ★ A FAULT IS NOT A REFUSAL. Transport failures, rejected credentials, timeouts
 * and upstream errors must let the payment through. Only a definitive data answer
 * from the provider stops a checkout; anything else is reported and ignored,
 * because an outage must not take the payment page down with it.
 */

import { logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';
import { settingsService } from '../settings/settings.service.js';
import { resolveConfiguredAdaptorId } from '../adaptors/activeAdaptor.service.js';
import { adaptorRegistry } from '../adaptors/registry.js';
import { connectAdaptor } from '../adaptors/credentials.provider.js';
import type {
  AccountingAdaptor,
  AdaptorId,
  CustomerMatchConfig,
  PreflightRejection,
} from '../../types/adaptor.js';

export interface PaymentPreflightInput {
  organizationId: string;
  /** The customer identifier the gateway will echo back. */
  matchValue: string;
  /** Major units, verbatim — the figure the customer is about to be charged. */
  amount: string;
  currency: string;
}

/**
 * The seam `PaymentService` depends on. A function rather than the class so a
 * caller can skip pre-flight without knowing how it is wired.
 */
export type PaymentPreflight = (input: PaymentPreflightInput) => Promise<void>;

export interface PaymentPreflightDeps {
  resolveAdaptorId?: () => Promise<AdaptorId | null>;
  resolveMatchConfig?: () => Promise<CustomerMatchConfig | null>;
  adaptors?: { get(id: AdaptorId): AccountingAdaptor };
  connect?: (adaptor: AccountingAdaptor) => Promise<void>;
}

/**
 * The fix, in the operator's language.
 *
 * NONE OF THESE ECHO A CUSTOMER NAME, AN INVOICE FIGURE OR THE REFERENCE. The
 * caller supplied the reference, and the provider supplied the rest; repeating
 * either into an HTTP response would put ledger data in a browser. What the
 * sentence must do is name the action that makes the payment possible.
 */
const REFUSALS: Record<PreflightRejection, string> = {
  'customer-not-found':
    'No accounting customer matches this identifier. Check the customer identifier and the accounting matching rule before taking payment.',
  'customer-ambiguous':
    'More than one accounting customer matches this identifier. Make the identifier unique in the accounting system before taking payment.',
  'invoice-not-found':
    'The matched accounting customer has no outstanding invoice. Create or open the invoice before taking payment.',
  'amount-invalid':
    'The amount is not a figure the accounting system can accept. Correct the amount and try again.',
  'amount-exceeds-balance':
    'The amount is more than the customer\'s total outstanding balance. Reduce it to that total or less before taking payment.',
  'currency-mismatch':
    'The payment currency does not match the invoice currency. Use the invoice currency, or correct the invoice.',
};

export class PaymentPreflightService {
  constructor(private readonly deps: PaymentPreflightDeps = {}) {}

  async check(input: PaymentPreflightInput): Promise<void> {
    let adaptorId: AdaptorId | null = null;
    try {
      adaptorId = await (this.deps.resolveAdaptorId ?? resolveConfiguredAdaptorId)();
      if (!adaptorId) return;

      const match = await (
        this.deps.resolveMatchConfig ?? (() => settingsService.resolveMatchConfig())
      )();
      // No rule means no way to resolve the customer, which is also the state
      // the push is in: it does not guess, so there is nothing to pre-check.
      if (!match) return;

      const adaptor = (this.deps.adaptors ?? adaptorRegistry).get(adaptorId);
      if (!adaptor.preflightPayment) return;

      if ((await adaptor.status()) !== 'connected') {
        await (this.deps.connect ?? connectAdaptor)(adaptor);
      }

      const outcome = await adaptor.preflightPayment({
        matchValue: input.matchValue,
        amount: input.amount,
        currency: input.currency,
        match,
      });
      if (outcome.ok) return;

      throw new Refusal(outcome.reason ?? 'amount-invalid');
    } catch (err) {
      if (err instanceof Refusal) {
        throw new ValidationError(REFUSALS[err.reason]);
      }
      /*
        A fault, not a verdict. Identity and the adaptor are safe to log; the
        amount, the reference and everything the provider said about an entity
        are not. `err` here is one of our own classified errors, whose message is
        a status code or a sentence about the connection.
      */
      logger.warn(
        { adaptor: adaptorId, err },
        'Payment pre-flight could not be completed; allowing the checkout',
      );
    }
  }
}

/** Internal marker so a data refusal is not mistaken for a fault. */
class Refusal extends Error {
  constructor(readonly reason: PreflightRejection) {
    super(reason);
    this.name = 'Refusal';
  }
}

const defaultService = new PaymentPreflightService();

/** The pre-flight `PaymentService` uses unless a test supplies its own. */
export const defaultPaymentPreflight: PaymentPreflight = (input) => defaultService.check(input);
