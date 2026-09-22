import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';
import { getRepositories } from '../../repositories/index.js';
import { InMemoryEventRepository } from '../../repositories/inMemory.js';
import type { EventRepository } from '../../types/repository.js';
import type { LifecycleChannel, LifecycleEvent, LifecycleEventType } from '../../models/domain.js';

export interface EventLogInput {
  type: LifecycleEventType;
  channel: string;
  ref: string;
  detail: string;
  /** Organization the event belongs to (C1). Stored org-scoped. */
  organizationId: string;
}

/**
 * Sensitive patterns that must never appear in a logged event detail.
 * Covers amounts, card numbers, emails, SSNs, IBANs and long numeric ids.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\$\s?\d[\d,]*(\.\d+)?/g, // currency amounts like $1,234.56
  /\b\d[\d,]*\.\d{2}\b/g, // decimal amounts like 123.45
  /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/g, // formatted card numbers
  /\b\d{13,19}\b/g, // raw card / long numeric identifiers
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, // email addresses
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, // IBAN
];

/**
 * Allowed lifecycle channels (mirrors the domain `LifecycleChannel` union).
 */
const LIFECYCLE_CHANNELS: readonly LifecycleChannel[] = [
  'payment',
  'accounting',
  'webhook',
  'system',
];

function isLifecycleChannel(value: string): value is LifecycleChannel {
  return (LIFECYCLE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Validate a raw channel string against the allowed union, throwing
 * `ValidationError` instead of blindly casting.
 */
export function validateChannel(channel: string): LifecycleChannel {
  if (!isLifecycleChannel(channel)) {
    throw new ValidationError(`Invalid lifecycle channel: ${channel}`);
  }
  return channel;
}

/**
 * Strip sensitive patterns from a detail string, replacing them with a
 * redaction marker. Enforces FR-5.2 (no financial/customer data in logs).
 *
 * LIMITATION: bare integer amounts (e.g. "total 5000") are intentionally not
 * matched, to avoid over-redacting legitimate reference ids. Callers must not
 * put bare numeric amounts into operational text.
 */
export function sanitizeDetail(detail: string): string {
  let sanitized = detail;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

/**
 * Guard that throws if sensitive data is present. Used as a final safety net
 * after sanitization so nothing sensitive can be persisted.
 */
export function assertNoSensitiveData(value: string, label = 'value'): void {
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      throw new ValidationError(`Sensitive data detected in ${label}`);
    }
  }
}

/**
 * Records lifecycle events (FR-5.1) with a hard privacy guarantee (FR-5.2).
 * Sanitization/redaction runs BEFORE persisting, then delegates to an
 * `EventRepository`.
 */
export class EventLog {
  constructor(private readonly events: EventRepository = new InMemoryEventRepository()) {}

  async recordEvent(input: EventLogInput): Promise<LifecycleEvent> {
    const channel = validateChannel(input.channel);
    const detail = sanitizeDetail(input.detail);
    assertNoSensitiveData(detail, 'event detail');
    // `ref` originates from the webhook payload — guard it too so a sensitive
    // reference can never be stored or logged raw (FR-2.3 / FR-5.2).
    assertNoSensitiveData(input.ref, 'event ref');

    const event: LifecycleEvent = {
      id: randomUUID(),
      organizationId: input.organizationId,
      at: new Date().toISOString(),
      type: input.type,
      channel,
      ref: input.ref,
      detail,
    };
    await this.events.append(event);
    logger.info({ eventType: event.type, ref: event.ref }, 'Lifecycle event recorded');
    return event;
  }

  async list(organizationIds: string[]): Promise<LifecycleEvent[]> {
    return this.events.list(organizationIds);
  }
}

/** Singleton event log backed by the shared repository container. */
export const eventLog = new EventLog(getRepositories().events);
