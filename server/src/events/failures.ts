import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { NotFoundError } from '../lib/errors.js';
import { assertNoSensitiveData, sanitizeDetail, validateChannel } from './eventLog.js';
import type { Failure, Severity } from '../domain/types.js';

export interface FailureInput {
  severity: Severity;
  channel: string;
  title: string;
  detail: string;
}

/**
 * Tracks critical failures (FR-5.3) so they can be surfaced on the monitoring
 * dashboard. Title/detail are sanitized with the same FR-5.2 guard as the
 * event log.
 *
 * LIMITATION: persists to an in-memory array — data is lost on restart. DB
 * persistence is Phase 5.
 */
export class FailureTracker {
  private readonly failures: Failure[] = [];
  private readonly acknowledgedIds = new Set<string>();

  async recordFailure(input: FailureInput): Promise<Failure> {
    const channel = validateChannel(input.channel);
    const title = sanitizeDetail(input.title);
    const detail = sanitizeDetail(input.detail);
    assertNoSensitiveData(title, 'failure title');
    assertNoSensitiveData(detail, 'failure detail');

    const failure: Failure = {
      id: randomUUID(),
      severity: input.severity,
      channel,
      title,
      detail,
      since: new Date().toISOString(),
    };
    this.failures.push(failure);
    logger.warn({ failureId: failure.id, severity: failure.severity }, 'Failure recorded');
    return failure;
  }

  list(): Failure[] {
    return [...this.failures];
  }

  async acknowledge(id: string): Promise<Failure> {
    const failure = this.failures.find((f) => f.id === id);
    if (!failure) {
      throw new NotFoundError(`Failure not found: ${id}`);
    }
    this.acknowledgedIds.add(id);
    logger.info({ failureId: id }, 'Failure acknowledged');
    return failure;
  }
}

/** Singleton failure tracker. */
export const failureTracker = new FailureTracker();
