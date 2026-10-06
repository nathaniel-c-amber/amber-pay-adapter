import {
  assertNoPlaceholderSecrets,
  assertValidSmtpConfig,
  envSchema,
} from './env.js';

/**
 * The origin the CSP lets a card form be posted to.
 *
 * Parsed through the SCHEMA rather than by reading `env`, because `env` is the
 * result of parsing `process.env` at import time — a test could only assert
 * about whatever the test environment happened to contain.
 */
function parseOrigin(value: unknown) {
  return envSchema.shape['AMBER_PAY_CHECKOUT_ORIGIN'].safeParse(value);
}

describe('the checkout origin', () => {
  it('accepts a bare origin', () => {
    expect(parseOrigin('https://staging-payment.myamberpay.com').success).toBe(true);
  });

  it('refuses one carrying a path, which would match nothing in the CSP', () => {
    // `form-action` takes scheme and host. A path here produces a directive that
    // looks configured and silently breaks every checkout.
    const result = parseOrigin('https://gateway.example.com/gateway/v1');
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toMatch(/origin/);
  });

  it('refuses a malformed value instead of throwing while parsing it', () => {
    /*
      ★ A zod refinement runs even when the check before it has already failed.
      `.url()` refusing `not-a-url` does not stop the refinement, and `new URL()`
      on that value THROWS — so this was an unhandled exception while parsing
      configuration, i.e. a stack trace instead of a message naming the variable.
      A fail-fast check that fails by crashing is not a fail-fast check.
    */
    expect(() => parseOrigin('not-a-url')).not.toThrow();
    expect(parseOrigin('not-a-url').success).toBe(false);
  });

  it('refuses an empty string rather than defaulting past it', () => {
    // An empty value rendered `form-action 'self' ` with nothing after it, which
    // is a CSP that blocks the post — the exact silent breakage this is checked
    // at boot to prevent.
    expect(parseOrigin('').success).toBe(false);
  });
});

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