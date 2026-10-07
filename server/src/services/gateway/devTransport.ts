import { createHash } from 'node:crypto';
import type { AdaptorResponse, HttpMethod } from '../../types/adaptor.js';
import type { GatewayTransport } from '../../types/gateway.js';

/** How long a fabricated link claims to stay valid. Mirrors the real shape. */
const DEV_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** The path this transport has to answer differently from a link request. */
const SIGNATURE_PATH = 'generatesignature';

/**
 * A `GatewayTransport` that fabricates gateway responses locally.
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
 * ★ IT ANSWERS THE SIGNATURE CALL TOO, and it has to. Creating a checkout now
 * calls `/generatesignature` before anything else, and this transport used to
 * answer EVERY post with a fabricated link. So the one call the checkout makes
 * first received a body with no `Signature` in it, and the checkout failed with
 * "the gateway declined to sign" — which is precisely the report that would
 * send a developer hunting through gateway configuration for a fault this
 * transport had invented. The whole purpose here is to let the endpoint be
 * exercised end to end, and that stopped being true the moment the endpoint
 * grew a first call.
 *
 * THE SIGNATURE IS DETERMINISTIC AND OBVIOUSLY FAKE: it is derived from the
 * transaction id, so the same checkout always produces the same value and a
 * test can assert on it. It is prefixed rather than random precisely so it can
 * never be mistaken for one the gateway issued — a signature that looks real but
 * is not would be worse than no signature at all.
 *
 * PURE BY CONSTRUCTION: this module imports no `env`. Whether it is used at all
 * is decided by the caller (see `gatewayTransportFor`), so the policy cannot
 * drift into a module that has no business holding it.
 *
 * The fabricated bodies carry no amount, currency or customer PII — the same
 * privacy constraint the real payloads are held to (FR-2.3 / FR-5.2).
 */
export function createDevGatewayTransport(baseUrl: string): GatewayTransport {
  return async (
    method: HttpMethod,
    url: string,
    body?: unknown,
  ): Promise<AdaptorResponse> => {
    if (method !== 'POST') {
      // Mirrors a real upstream refusing an unimplemented verb, so an
      // unexpected call shape shows up as a status rather than a silent 201.
      return { status: 405, body: { message: `Method ${method} is not implemented` } };
    }

    if (url.includes(SIGNATURE_PATH)) {
      return { status: 200, body: { success: 'Y', Signature: fakeSignature(body) } };
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

/**
 * A stable, unmistakably fake signature for a transaction.
 *
 * Base64 of a digest that starts with a literal marker, so the value is
 * deterministic, obviously not issued by the gateway, and cannot collide with a
 * real one.
 */
function fakeSignature(body: unknown): string {
  const transactionId = readTransactionId(body);
  const digest = createHash('sha256')
    .update(`amber-pay-dev-signature:${transactionId ?? 'unknown'}`)
    .digest('base64');
  return `DEV${digest.slice(0, 40)}`;
}

/** Read the transaction id out of a request body without trusting its type. */
function readTransactionId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as { TransactionId?: unknown }).TransactionId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Read the opaque reference out of the request body without trusting its type. */
function readReference(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const reference = (body as { reference?: unknown }).reference;
  return typeof reference === 'string' && reference.length > 0 ? reference : undefined;
}
