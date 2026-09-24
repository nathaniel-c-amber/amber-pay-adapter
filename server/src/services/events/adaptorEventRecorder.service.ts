import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import { eventLog as defaultEventLog } from './eventLog.service.js';
import { failureTracker as defaultFailureTracker } from './failureTracker.service.js';
import type { EventLog } from './eventLog.service.js';
import type { FailureTracker } from './failureTracker.service.js';
import type { AdaptorFailureReason, AdaptorId } from '../../types/adaptor.js';

/**
 * Files accounting-adaptor observations into the lifecycle event log and the
 * findings list.
 *
 * THE GAP THIS CLOSES: adaptor reachability was observed on EVERY probe and
 * reported only through the service panel. Nothing wrote it to the event log,
 * so the console could show "QuickBooks answered 401" on the Overview while the
 * Event log page — the page an operator opens to ask "what has been happening?"
 * — stayed empty. The observation existed; it just never reached the system of
 * record.
 *
 * TRANSITIONS, NOT POLLS. `probeAdaptors` runs on every service-status poll
 * (the console polls every 10s), so recording each outcome would append
 * thousands of identical rows an hour, crowd the event window that the flow
 * aggregate is derived from, and drown a real incident in its own repetition.
 * Only a CHANGE of state is an event: down (with a reason), a different reason
 * while still down, and back up.
 *
 * THE OBSERVATION IS REMEMBERED BEFORE ANY WRITE AWAITS. Two overlapping probes
 * must not both conclude "this is new" and double-log it, so the in-memory
 * observation is stored synchronously and the writes follow.
 *
 * NOTHING HERE MAY THROW. This runs inside the probe that feeds the console, so
 * a failed write is logged and swallowed: the monitoring system must never be
 * the reason the thing it monitors stops answering.
 */
export interface AdaptorOutcome {
  id: AdaptorId;
  name: string;
  /** Did the adaptor answer? */
  reachable: boolean;
  /** Why not, when `reachable` is false. */
  reason?: AdaptorFailureReason;
  /** The adaptor's own explanation, shown as the event/finding detail. */
  message?: string;
}

/**
 * The organization adaptor observations are filed under.
 *
 * ONE DEPLOYMENT, ONE ORGANIZATION. Adaptors are registered per PROCESS
 * (`adaptorRegistry`), so an observation such as "QuickBooks is unreachable"
 * applies to the whole deployment — which is now exactly one organization. The
 * value therefore comes from deployment configuration rather than a literal, and
 * it is the SAME value `webhookProcessor` files under, so the console reads one
 * coherent stream instead of two disjoint ones.
 *
 * That coherence is the point: observations filed under an id no policy names
 * are invisible to every user of the organization they are about.
 */
const DEFAULT_ORGANIZATION_ID = env.ORGANIZATION_ID;

/**
 * Adaptor id -> the identity of the state it was last seen in. The signature is
 * deliberately the REASON, not the message: the upstream rewording its error
 * text is not a new outage.
 */
type Observation = string;

export class AdaptorEventRecorder {
  private readonly observations = new Map<AdaptorId, Observation>();

  constructor(
    private readonly events: EventLog = defaultEventLog,
    private readonly failures: FailureTracker = defaultFailureTracker,
    private readonly organizationId: string = DEFAULT_ORGANIZATION_ID,
  ) {}

  /**
   * File a batch of probe outcomes, recording only the ones that changed.
   * Sequential on purpose: the writes must not race each other's dedup state.
   */
  async recordOutcomes(outcomes: AdaptorOutcome[]): Promise<void> {
    for (const outcome of outcomes) {
      try {
        await this.recordOutcome(outcome);
      } catch (err) {
        logger.warn(
          { adaptor: outcome.id, err },
          'Failed to record an adaptor lifecycle event (continuing)',
        );
      }
    }
  }

  /**
   * Test seam. A real process starts with no memory of previous probes, so a
   * fresh instance (or a reset) is what a restart looks like.
   */
  reset(): void {
    this.observations.clear();
  }

  private async recordOutcome(outcome: AdaptorOutcome): Promise<void> {
    const signature = outcome.reachable ? 'reachable' : `down:${outcome.reason ?? 'unreachable'}`;
    const previous = this.observations.get(outcome.id);
    this.observations.set(outcome.id, signature);

    if (previous === signature) {
      return;
    }

    if (outcome.reachable) {
      // Healthy from the first look is not an event: an adaptor that has always
      // worked is not news, and recording it would fill the log with starts.
      if (!previous) {
        return;
      }
      await this.events.recordEvent({
        type: 'adaptor-restored',
        channel: 'accounting',
        ref: outcome.id,
        detail: `${outcome.name} is reachable again`,
        organizationId: this.organizationId,
      });
      return;
    }

    const authFailed = outcome.reason === 'auth';
    const message = outcome.message?.trim();

    await this.events.recordEvent({
      type: authFailed ? 'adaptor-auth-failed' : 'adaptor-unreachable',
      channel: 'accounting',
      // The adaptor id is a stable pseudo-reference: it groups this adaptor's
      // state changes together in the log without inventing a payment ref.
      ref: outcome.id,
      detail: `${outcome.name}: ${message || 'health probe failed'}`,
      organizationId: this.organizationId,
    });

    await this.failures.recordFailure({
      // A rate limit clears itself; a rejected token or an unreachable host
      // needs a human. Different weight, so it is not one critical alarm.
      severity: outcome.reason === 'rate-limited' ? 'attention' : 'critical',
      channel: 'accounting',
      title: authFailed
        ? `${outcome.name} rejected our credentials`
        : `${outcome.name} is not answering`,
      detail: message || 'Health probe failed',
      organizationId: this.organizationId,
    });
  }
}

/** Singleton recorder shared by the probe and the startup connection path. */
export const adaptorEventRecorder = new AdaptorEventRecorder();
