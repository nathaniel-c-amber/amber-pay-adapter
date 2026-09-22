import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { NotFoundError } from '../../utils/errors.js';
import { assertNoSensitiveData, sanitizeDetail, validateChannel } from './eventLog.service.js';
import { getRepositories } from '../../repositories/index.js';
import { InMemoryFailureRepository } from '../../repositories/inMemory.js';
import type { FailureRepository } from '../../types/repository.js';
import type { Failure, Severity } from '../../models/domain.js';

export interface FailureInput {
  severity: Severity;
  channel: string;
  title: string;
  detail: string;
  /** Organization the failure belongs to (C1). Stored org-scoped. */
  organizationId: string;
}

/**
 * Tracks critical failures (FR-5.3) so they can be surfaced on the monitoring
 * dashboard. Title/detail are sanitized with the same FR-5.2 guard as the
 * event log, then delegated to a `FailureRepository`.
 */
export class FailureTracker {
  constructor(private readonly failures: FailureRepository = new InMemoryFailureRepository()) {}

  async recordFailure(input: FailureInput): Promise<Failure> {
    const channel = validateChannel(input.channel);
    const title = sanitizeDetail(input.title);
    const detail = sanitizeDetail(input.detail);
    assertNoSensitiveData(title, 'failure title');
    assertNoSensitiveData(detail, 'failure detail');

    const failure: Failure = {
      id: randomUUID(),
      organizationId: input.organizationId,
      severity: input.severity,
      channel,
      title,
      detail,
      since: new Date().toISOString(),
    };
    await this.failures.append(failure);
    logger.warn({ failureId: failure.id, severity: failure.severity }, 'Failure recorded');
    return failure;
  }

  async list(organizationIds: string[]): Promise<Failure[]> {
    return this.failures.list(organizationIds);
  }

  async acknowledge(id: string, organizationIds: string[]): Promise<Failure> {
    const failure = await this.failures.acknowledge(id, new Date().toISOString(), organizationIds);
    if (!failure) {
      throw new NotFoundError(`Failure not found: ${id}`);
    }
    logger.info({ failureId: id }, 'Failure acknowledged');
    return failure;
  }
}

/** Singleton failure tracker backed by the shared repository container. */
export const failureTracker = new FailureTracker(getRepositories().failures);
