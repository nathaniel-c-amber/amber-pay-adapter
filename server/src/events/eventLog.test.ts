import { EventLog, assertNoSensitiveData, sanitizeDetail } from './eventLog.js';
import { ValidationError } from '../lib/errors.js';

describe('EventLog', () => {
  it('recordEvent sanitizes sensitive detail', async () => {
    const eventLog = new EventLog();
    const event = await eventLog.recordEvent({
      type: 'collected',
      channel: 'webhook',
      ref: 'ref-0001',
      detail: 'Payment of $1,234.56 for card 4111 1111 1111 1111 to customer@example.com',
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
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('list returns recorded events', async () => {
    const eventLog = new EventLog();
    await eventLog.recordEvent({
      type: 'initiated',
      channel: 'webhook',
      ref: 'ref-0001',
      detail: 'Payment initiated',
    });
    await eventLog.recordEvent({
      type: 'collected',
      channel: 'webhook',
      ref: 'ref-0002',
      detail: 'Payment collected',
    });

    expect(eventLog.list()).toHaveLength(2);
    expect(eventLog.list()[0]?.type).toBe('initiated');
    expect(eventLog.list()[1]?.type).toBe('collected');
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
