import { assertNoPlaceholderSecrets } from './env.js';

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