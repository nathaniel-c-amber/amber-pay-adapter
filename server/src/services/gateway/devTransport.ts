import type { AdaptorResponse, HttpMethod } from '../../types/adaptor.js';
import type { GatewayTransport } from '../../types/gateway.js';

/** How long a fabricated link claims to stay valid. Mirrors the real shape. */
const DEV_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A `GatewayTransport` that fabricates a payment link locally.
 *
 * The gateway is still stubbed, so `POST /api/v1/payments` returned 502 before
 * it could be exercised at all — the transport threw before any network call,
 * which also made the failure indistinguishable from a genuine network problem.
 * This fills in the seam the class already had, without inventing a second
 * network client: nothing here opens a socket, so a test never waits on a
 * timeout and never depends on a host being reachable.
 *
 * It is deliberately NOT a real HTTP transport. `AMBER_PAY_BASE_URL` defaults to
 * `api.amberpay.example.com`, which does not exist, so pointing `fetch` at it
 * would trade an instant, legible 502 for a 5-second timeout on every request.
 *
 * PURE BY CONSTRUCTION: this module imports no `env`. Whether it is used at all
 * is decided by the caller (see `gatewayTransportFor`), so the policy cannot
 * drift into a module that has no business holding it.
 *
 * The fabricated body carries no amount, currency or customer PII — the same
 * privacy constraint the real payload is held to (FR-2.3 / FR-5.2).
 */
export function createDevGatewayTransport(baseUrl: string): GatewayTransport {
  return async (
    method: HttpMethod,
    _url: string,
    body?: unknown,
  ): Promise<AdaptorResponse> => {
    if (method !== 'POST') {
      // Mirrors a real upstream refusing an unimplemented verb, so an
      // unexpected call shape shows up as a status rather than a silent 201.
      return { status: 405, body: { message: `Method ${method} is not implemented` } };
    }

    const reference = readReference(body);
    return {
      status: 201,
      body: {
        linkUrl: `${baseUrl}/pay/${encodeURIComponent(String(reference ?? 'unknown'))}`,
        reference,
        expiresAt: new Date(Date.now() + DEV_LINK_TTL_MS).toISOString(),
        simulated: true,
      },
    };
  };
}

/** Read the opaque reference out of the request body without trusting its type. */
function readReference(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const reference = (body as { reference?: unknown }).reference;
  return typeof reference === 'string' && reference.length > 0 ? reference : undefined;
}
