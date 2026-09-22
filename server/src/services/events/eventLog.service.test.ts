import { EventLog, assertNoSensitiveData, sanitizeDetail } from './eventLog.service.js';
import { ValidationError } from '../../utils/errors.js';

describe('EventLog', () => {
  it('recordEvent sanitizes sensitive detail', async () => {
    const eventLog = new EventLog();
    const event = await eventLog.recordEvent({
      type: 'collected',
      channel: 'webhook',
      ref: 'ref-0001',
      detail: 'Payment of $1,234.56 for card 4111 1111 1111 1111 to customer@example.com',
      organizationId: 'org-1',
    });

    expect(event.detail).not.toContain('$');
    expect(event.detail).not.toContain('4111');
    expect(event.detail).not.toContain('@');
    expect(event.detail).toContain('[REDACTED]');
  });

  it('recordEvent rejects a sensitive ref', async () => {
    const eventLog = new EventLog();
    await expect(
      eventLog.recordEvent({
        type: 'collected',
        channel: 'webhook',
        ref: 'customer@example.com',
        detail: 'Payment collected',
        organizationId: 'org-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('recordEvent rejects an invalid channel', async () => {
    const eventLog = new EventLog();
    await expect(
      eventLog.recordEvent({
        type: 'collected',
        channel: 'not-a-channel',
        ref: 'ref-0001',
        detail: 'Payment collected',
        organizationId: 'org-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('list returns recorded events for the given organizations', async () => {
    const eventLog = new EventLog();
    await eventLog.recordEvent({
      type: 'initiated',
      channel: 'webhook',
      ref: 'ref-0001',
      detail: 'Payment initiated',
      organizationId: 'org-1',
    });
    await eventLog.recordEvent({
      type: 'collected',
      channel: 'webhook',
      ref: 'ref-0002',
      detail: 'Payment collected',
      organizationId: 'org-1',
    });

    const events = await eventLog.list(['org-1']);
    expect(events).toHaveLength(2);
    // Both recorded events are returned (order is by `at` DESC, which ties at
    // identical millisecond timestamps here).
    expect(events.map((e) => e.type).sort()).toEqual(['collected', 'initiated']);
  });

  it('list excludes events for organizations not requested (C1)', async () => {
    const eventLog = new EventLog();
    await eventLog.recordEvent({
      type: 'initiated',
      channel: 'webhook',
      ref: 'ref-0001',
      detail: 'Payment initiated',
      organizationId: 'org-1',
    });
    await eventLog.recordEvent({
      type: 'collected',
      channel: 'webhook',
      ref: 'ref-0002',
      detail: 'Payment collected',
      organizationId: 'org-2',
    });

    const events = await eventLog.list(['org-1']);
    expect(events).toHaveLength(1);
    expect(events[0]?.organizationId).toBe('org-1');
  });
});

describe('sanitizeDetail', () => {
  it('redacts sensitive patterns', () => {
    const sanitized = sanitizeDetail('Amount $99.99, card 4111-1111-1111-1111, email a@b.com');
    expect(sanitized).not.toContain('$');
    expect(sanitized).not.toContain('4111');
    expect(sanitized).not.toContain('@');
  });
});

describe('assertNoSensitiveData', () => {
  it('throws on sensitive data', () => {
    expect(() => assertNoSensitiveData('card 4111 1111 1111 1111')).toThrow(ValidationError);
  });

  it('throws on a sensitive ref', () => {
    expect(() => assertNoSensitiveData('customer@example.com', 'ref')).toThrow(ValidationError);
  });

  it('does not throw on safe detail', () => {
    expect(() => assertNoSensitiveData('Payment collected')).not.toThrow();
  });
});
