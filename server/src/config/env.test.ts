import { assertNoPlaceholderSecrets, assertValidSmtpConfig } from './env.js';

describe('assertNoPlaceholderSecrets', () => {
  it('rejects a placeholder JWT_SECRET in production', () => {
    expect(() =>
      assertNoPlaceholderSecrets(
        'production',
        'change-me-jwt-secret-0123456789abcdef',
        'a-real-webhook-secret-0123456789',
      ),
    ).toThrow(/JWT_SECRET/);
  });

  it('rejects a placeholder AMBER_PAY_WEBHOOK_SECRET in production', () => {
    expect(() =>
      assertNoPlaceholderSecrets(
        'production',
        'a-real-jwt-secret-0123456789abcdef',
        'change-me-webhook-secret',
      ),
    ).toThrow(/AMBER_PAY_WEBHOOK_SECRET/);
  });

  it('rejects a placeholder SUPER_ADMIN_PASSWORD in production', () => {
    expect(() =>
      assertNoPlaceholderSecrets(
        'production',
        'a-real-jwt-secret-0123456789abcdef',
        'a-real-webhook-secret-0123456789',
        'change-me-super-admin-password',
      ),
    ).toThrow(/SUPER_ADMIN_PASSWORD/);
  });

  it('rejects a placeholder SMTP_PASS in production', () => {
    expect(() =>
      assertNoPlaceholderSecrets(
        'production',
        'a-real-jwt-secret-0123456789abcdef',
        'a-real-webhook-secret-0123456789',
        undefined,
        'change-me-smtp-pass',
      ),
    ).toThrow(/SMTP_PASS/);
  });

  it('accepts real-looking secrets in production', () => {
    expect(() =>
      assertNoPlaceholderSecrets(
        'production',
        'a-real-jwt-secret-0123456789abcdef',
        'a-real-webhook-secret-0123456789',
      ),
    ).not.toThrow();
  });

  it('does not reject placeholders outside production (dev/test)', () => {
    expect(() =>
      assertNoPlaceholderSecrets(
        'development',
        'change-me-jwt-secret-0123456789abcdef',
        'change-me-webhook-secret',
      ),
    ).not.toThrow();
  });
});

describe('assertValidSmtpConfig', () => {
  it('allows SMTP to be unconfigured', () => {
    expect(() => assertValidSmtpConfig(undefined, undefined, undefined, undefined)).not.toThrow();
  });

  it('requires SMTP_FROM when SMTP_HOST is set', () => {
    expect(() => assertValidSmtpConfig('smtp.example.com', undefined, undefined, undefined)).toThrow(
      /SMTP_FROM/,
    );
  });

  it('requires SMTP_USER and SMTP_PASS together', () => {
    expect(() =>
      assertValidSmtpConfig('smtp.example.com', 'no-reply@example.com', 'user', undefined),
    ).toThrow(/SMTP_USER and SMTP_PASS/);
    expect(() =>
      assertValidSmtpConfig('smtp.example.com', 'no-reply@example.com', undefined, 'pass'),
    ).toThrow(/SMTP_USER and SMTP_PASS/);
  });

  it('accepts a complete SMTP config', () => {
    expect(() =>
      assertValidSmtpConfig('smtp.example.com', 'no-reply@example.com', 'user', 'pass'),
    ).not.toThrow();
  });
});