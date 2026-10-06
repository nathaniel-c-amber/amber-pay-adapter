import { createDevGatewayTransport } from './devTransport.js';
import type { AmberPayGateway } from '../../types/gateway.js';

/**
 * The 502 an unconfigured gateway reports.
 *
 * Asserted as the wire contract (code + status) rather than by error class:
 * `jest.resetModules()` gives the re-imported module its OWN copy of
 * `AdaptorConnectionError`, so `instanceof` can never hold across a reset. The
 * code and status are what the error handler actually turns into a response,
 * so they are the more meaningful assertion anyway.
 */
const STUBBED_502 = { code: 'ADAPTOR_CONNECTION_ERROR', statusCode: 502 };

/**
 * `env` is parsed at module load, so the two gates cannot be exercised by
 * mutating a shared object. Each case re-imports the module against a patched
 * `process.env` — the same shape the settings singleton is pinned with, and the
 * only one that can actually distinguish "flag off" from "flag never read".
 */
async function importGateway(overrides: Record<string, string>): Promise<AmberPayGateway> {
  const previous = { ...process.env };
  Object.assign(process.env, overrides);
  jest.resetModules();
  try {
    const mod = await import('./amberpay.service.js');
    return new mod.AmberPayGatewayImpl();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

const linkInput = {
  invoiceId: 'INV-1042',
  externalInvoiceId: 'QBO-1042',
  reference: 'ref_0001042A',
  status: 'initiated' as const,
};

describe('createDevGatewayTransport', () => {
  it('fabricates a link and marks it simulated', async () => {
    const transport = createDevGatewayTransport('https://gateway.test');
    const response = await transport('POST', 'https://gateway.test/payment-links', {
      ...linkInput,
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      reference: 'ref_0001042A',
      simulated: true,
    });
    const body = response.body as Record<string, unknown>;
    expect(String(body['linkUrl'])).toContain('https://gateway.test/pay/');
    expect(String(body['expiresAt'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('makes no network call — the point of a synthetic transport', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await createDevGatewayTransport('https://gateway.test')(
      'POST',
      'https://gateway.test/payment-links',
      { ...linkInput },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refuses a verb it does not implement instead of answering 201', async () => {
    const response = await createDevGatewayTransport('https://gateway.test')(
      'GET',
      'https://gateway.test/payment-links',
    );
    expect(response.status).toBe(405);
  });

  it('carries no amount, currency or customer PII (FR-2.3 / FR-5.2)', async () => {
    const response = await createDevGatewayTransport('https://gateway.test')(
      'POST',
      'https://gateway.test/payment-links',
      { ...linkInput, amount: 100, currency: 'GBP', customerEmail: 'a@b.com' },
    );
    const serialized = JSON.stringify(response.body).toLowerCase();
    expect(serialized).not.toContain('100');
    expect(serialized).not.toContain('gbp');
    expect(serialized).not.toContain('a@b.com');
  });
});

describe('the dev transport gate', () => {
  it('is OFF by default, so a plain developer stack still gets the real 502', async () => {
    const gateway = await importGateway({ AMBER_PAY_DEV_TRANSPORT: 'false' });
    await expect(gateway.createPaymentLink(linkInput)).rejects.toMatchObject(STUBBED_502);
  });

  it('is ON outside production when explicitly opted in', async () => {
    const gateway = await importGateway({ NODE_ENV: 'development', AMBER_PAY_DEV_TRANSPORT: 'true' });
    const result = await gateway.createPaymentLink(linkInput);
    expect(result.reference).toBe('ref_0001042A');
    expect(result.linkUrl).toContain('/pay/');
  });

  /*
    End to end through the gateway's response PARSING, not just the transport.
    The transport sets the flag on its body; the parse is a projection, and a
    projection that did not carry `simulated` dropped it — so the transport
    test passed while the API reported a fabricated link as genuine. Only a
    test that goes through the whole gateway could see that.
  */
  it('keeps the simulated flag all the way through createPaymentLink', async () => {
    const gateway = await importGateway({
      NODE_ENV: 'development',
      AMBER_PAY_DEV_TRANSPORT: 'true',
    });
    const result = await gateway.createPaymentLink(linkInput);
    expect(result.simulated).toBe(true);
  });

  /*
    The gate that matters. The `tunnel` compose profile publishes this stack on
    a public ngrok URL, and a non-production NODE_ENV is the NORMAL setting for
    that profile — so keying on NODE_ENV alone would publish a payment-minting
    endpoint to the internet. This is the test that fails if someone "simplifies"
    the condition to a single check.
  */
  it('stays OFF in production even when the flag is set', async () => {
    const gateway = await importGateway({ NODE_ENV: 'production', AMBER_PAY_DEV_TRANSPORT: 'true' });
    await expect(gateway.createPaymentLink(linkInput)).rejects.toMatchObject(STUBBED_502);
  });
});
