/* Minimal typed API client for the Amber Pay Ledger backend.
   Uses fetch. All endpoints are under /api/v1. */

import type {
  ApiAcknowledgeFailuresResponse,
  ApiAdaptorId,
  ApiAdaptorVerification,
  ApiCheckoutSession,
  ApiDeploymentSettings,
  ApiGatewayCurrency,
  ApiDirectoryUser,
  ApiIdentity,
  ApiInviteDetail,
  ApiInvoiceMatchMode,
  ApiInvoiceMatchStrategy,
  ApiPayment,
  ApiPolicyAttribute,
  ApiServiceStatus,
  MetricsResponse,
} from "@/types/api";

export const apiBaseUrl: string =
  import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

/** Thrown when the API returns 401 (missing/expired/invalid token). */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Any other non-2xx response, carrying the server's own message.
 *
 * The backend already writes messages meant for a human ("This password reset
 * link has expired"), and flattening them into "Request failed (401)" throws
 * away the only part that tells the user what to do next. The status is kept so
 * callers can branch on it without string-matching.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

async function errorFrom(res: Response): Promise<Error> {
  let code = "REQUEST_FAILED";
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as ErrorBody;
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // A non-JSON body (a proxy error page, say) leaves the generic message.
  }
  return res.status === 401
    ? new UnauthorizedError(message)
    : new ApiRequestError(res.status, code, message);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    throw await errorFrom(res);
  }

  // 202/204 responses carry no body worth parsing.
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * POST /payments — create a checkout for one customer.
 *
 * Returns a DESTINATION and the parameters for it, not a link: the gateway
 * expects a signed POST and answers with the payment form. The browser submits
 * that form to `checkoutUrl` directly, so card details reach the gateway and
 * never pass through this application — which is also why the CSP has to name
 * the gateway in `form-action`.
 *
 * The figure is MINOR UNITS (25000 is 250.00) and is only ever passed straight
 * through to the gateway's form. It is not stored by this console and not shown
 * anywhere else.
 */
export async function createCheckout(
  token: string,
  body: {
    invoiceId: string;
    studentId: string;
    /** MAJOR units as a decimal string — "250.00", never a number. */
    amount: string;
    currency: ApiGatewayCurrency;
  },
): Promise<{ checkout: ApiCheckoutSession }> {
  // No `organizationId` in the body: the server holds it and refuses a foreign
  // one, and the console has no way to read it — `/auth/me` carries the name,
  // `/settings` requires a scope an operator does not hold.
  return request<{ checkout: ApiCheckoutSession }>("/payments", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

/**
 * GET /payments/by-transaction/:transactionId — a payment by its gateway reference.
 *
 * AUTHORIZED, and no longer used by the payment return page: that page is for a
 * customer, who has no session, and it reads `getPaymentStatus` instead. This
 * remains the operator's lookup — the console's own surfaces correlate against a
 * gateway reference they already hold, and the route still exists on the server.
 */
export async function getPaymentByTransaction(
  token: string,
  transactionId: string,
): Promise<ApiPayment> {
  const result = await request<{ payment: ApiPayment }>(
    `/payments/by-transaction/${encodeURIComponent(transactionId)}`,
    { headers: authHeaders(token) },
  );
  return result.payment;
}

/* ----------------------------------------------- the customer's own status */

/**
 * The four things we can tell a customer about their own payment.
 *
 * `unknown` is the NORMAL answer for the first few seconds after someone pays:
 * the checkout intent exists (it was written before the customer was sent to the
 * gateway) but the gateway's callback has not been processed yet. It is a
 * pending answer, not a failure, and the UI must not render it as one.
 */
export type PaymentStatusState = "collected" | "failed" | "pending" | "unknown";

/**
 * GET /payments/status/:statusToken
 *
 * The shape the status endpoint answers with. NO WRAPPER, unlike most routes
 * here — the response IS the record.
 */
export interface PaymentStatus {
  status: PaymentStatusState;
  /** The gateway's own reference, e.g. "E09KUZXK6BZJ". What a customer quotes. */
  reference: string | null;
  /** The gateway's own words, captured server-side. Never from the URL. */
  reason: string | null;
  /**
   * MAJOR units as a STRING — "25000", never 25000.00 and never a number.
   *
   * A string because a binary float cannot hold a monetary figure exactly, and
   * the console must not re-parse it to print it: it groups the digits and puts
   * the currency symbol in front. See `formatAmount` in `@/utils/paymentReturn`.
   */
  amount: string | null;
  currency: string | null;
}

/**
 * The lookup a customer returning from the gateway needs — and the ONLY call on
 * this page.
 *
 * ★ PUBLIC AND SESSION-FREE, AND THAT IS THE POINT.
 *
 * The `statusToken` is 256 bits of base64url minted when the payment was
 * created. It carries no customer identity and is not bound to a session, so a
 * person who has just paid is not made to sign in to somebody else's operator
 * console to be told whether their money arrived. It is a lookup handle and
 * nothing more: what it resolves to is the server's record, never a claim the
 * browser can make about itself.
 *
 * No Authorization header is sent, and none is needed — there is nothing here to
 * authorize, because there is nothing here to see.
 *
 * `cache: "no-store"` is load-bearing for the same reason it is on `checkHealth`:
 * a cached 200 would keep answering "Confirming your payment" long after the
 * payment settled, and this page's entire job is not to be stale.
 */
export async function getPaymentStatus(statusToken: string): Promise<PaymentStatus> {
  return request<PaymentStatus>(`/payments/status/${encodeURIComponent(statusToken)}`, {
    method: "GET",
    cache: "no-store",
  });
}

/* ------------------------------------------------------------ liveness */

export interface HealthResult {
  online: boolean;
  /** Round-trip time in ms, or null when the probe did not complete. */
  latencyMs: number | null;
}

/**
 * GET /health — is the backend answering?
 *
 * Deliberately bypasses `request()`: that helper throws on any non-2xx and has
 * no concept of reachability, whereas the entire purpose here is to tell
 * "answered" apart from "did not answer" WITHOUT treating the latter as an
 * exception the caller must catch. Every failure mode — DNS, refused connection,
 * timeout, 5xx — is the same answer to the only question being asked, so they
 * collapse into `online: false`.
 *
 * `cache: "no-store"` is load-bearing. A cached 200 would keep reporting
 * "Online" after the backend went away, which is precisely the lie a status
 * indicator exists to prevent.
 */
export async function checkHealth(signal?: AbortSignal): Promise<HealthResult> {
  const started = performance.now();
  try {
    const res = await fetch(`${apiBaseUrl}/health`, {
      method: "GET",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return { online: false, latencyMs: null };
    return { online: true, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { online: false, latencyMs: null };
  }
}

/** GET /dashboard/metrics — requires a Bearer token. */
export function getMetrics(token: string): Promise<MetricsResponse> {
  return request<MetricsResponse>("/dashboard/metrics", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * POST /failures/acknowledge — acknowledges findings as ONE operator action
 * (Bearer token).
 *
 * The console acknowledges an INCIDENT, which may be several occurrences, so this
 * is the only acknowledgement call the UI makes: one request, one timestamp, one
 * attribution, whatever the size. `POST /failures/:id/acknowledge` still exists
 * on the server and is still covered by its tests, but nothing in the console
 * calls it — a second client path would be a second place for the busy flag and
 * the sign-out-on-401 handling to drift.
 *
 * Only the ids are sent. The actor is recorded by the server from the access
 * token, so there is deliberately no `acknowledgedBy` field here to fill in —
 * a client cannot acknowledge on someone else's behalf.
 *
 * Resolves with the rows the server ACTUALLY acknowledged, which may be fewer
 * than were sent if the console was stale. Callers should reconcile against the
 * response rather than assuming the whole list cleared.
 */
export function acknowledgeFailures(
  token: string,
  ids: string[],
): Promise<ApiAcknowledgeFailuresResponse> {
  return request<ApiAcknowledgeFailuresResponse>("/failures/acknowledge", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ids }),
  });
}

/** POST /auth/login — password step; returns a 2FA challenge id.
 *  In dev mode, also returns the raw code for auto-fill. */
export async function login(
  email: string,
  password: string,
): Promise<{ challengeId: string; code?: string }> {
  return request<{ challengeId: string; code?: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

/** GET /reports/reconciliation — operational counts only (no amounts). */
export interface ReconciliationReport {
  reconciliation: {
    status: string;
    matched: number;
    unmatched: number;
    anomalies: number;
    ranAt: string;
  } | null;
  generatedAt: string;
}

export function getReconciliationReport(token: string): Promise<ReconciliationReport> {
  return request<ReconciliationReport>("/reports/reconciliation", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * GET /service/status — the console's window into its own backend.
 *
 * Reports process uptime, storage backend and per-adaptor reachability so the
 * operator can tell "the pipeline is healthy" apart from "the console cannot
 * see the pipeline". That distinction is the whole point: a monitoring screen
 * whose panels read green over hours-old data is worse than one that admits
 * it is blind.
 */
export function getServiceStatus(token: string): Promise<ApiServiceStatus> {
  return request<ApiServiceStatus>("/service/status", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** POST /auth/2fa/verify — verifies the code and returns an access token. */export async function verifyTwoFactor(
  challengeId: string,
  code: string,
): Promise<{ accessToken: string }> {
  return request<{ accessToken: string }>("/auth/2fa/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId, code }),
  });
}

/**
 * GET /auth/invite/:token — what an outstanding invite carries.
 *
 * Reading is not accepting: this validates the token exactly as accept-invite
 * does (so an expired or already-used link is caught here, before the invitee
 * types a password) but consumes nothing, which is what makes reloading the
 * page safe.
 */
export async function getInvite(token: string): Promise<ApiInviteDetail> {
  const body = await request<{ invite: ApiInviteDetail }>(
    `/auth/invite/${encodeURIComponent(token)}`,
    { method: "GET" },
  );
  return body.invite;
}

/**
 * POST /auth/accept-invite — the only user-creation path in the product.
 *
 * Public and token-gated. The invite carries the policy attributes the account
 * will hold, which is why the password is the only thing this call supplies:
 * an invited user never chooses their own scope, and nothing client-side could
 * be trusted to set it anyway.
 */
export async function acceptInvite(
  token: string,
  password: string,
): Promise<{ status: string; userId: string }> {
  return request<{ status: string; userId: string }>("/auth/accept-invite", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

/* -------------------------------------------------- self-service recovery */

/**
 * POST /auth/forgot-password — request a reset link.
 *
 * Always 202, whether or not the address is registered, so the response cannot
 * be used to enumerate accounts. The UI must not imply otherwise by claiming a
 * message was definitely sent.
 *
 * In dev/test the backend returns the raw token so the flow can be exercised
 * without a mailbox; it is never returned in production.
 */
export async function requestPasswordReset(
  email: string,
): Promise<{ status: string; message: string; token?: string }> {
  return request<{ status: string; message: string; token?: string }>(
    "/auth/forgot-password",
    { method: "POST", body: JSON.stringify({ email }) },
  );
}

/** POST /auth/reset-password — redeem a reset token for a new password. */
export async function resetPassword(
  token: string,
  password: string,
): Promise<{ status: string }> {
  return request<{ status: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

/* ------------------------------------------------------------- identity */

/** GET /auth/me — the signed-in user's own identity and granted policy. */
export function getCurrentUser(token: string): Promise<ApiIdentity> {
  return request<ApiIdentity>("/auth/me", {
    method: "GET",
    headers: authHeaders(token),
  });
}

/**
 * POST /auth/me/tour-complete — stamp the caller's own first-run tour as seen.
 *
 * Self-service and idempotent: the API answers 204 whether or not the stamp was
 * already there, so a retry after a dropped response is safe and cannot fail on
 * "already done". Errors are the caller's to swallow — a tour that could not be
 * recorded must not interrupt the tour itself.
 */
export async function completeTour(token: string): Promise<void> {
  await request<void>("/auth/me/tour-complete", {
    method: "POST",
    headers: authHeaders(token),
  });
}

/* ------------------------------------------------- administrator surfaces */

/** GET /users — the admin user directory (accounts + outstanding invites). */
export async function listUsers(token: string): Promise<ApiDirectoryUser[]> {
  const body = await request<{ users: ApiDirectoryUser[] }>("/users", {
    method: "GET",
    headers: authHeaders(token),
  });
  return body.users;
}

/** PATCH /users/:id — replace an account's PBAC attributes. */
export async function updateUserPermissions(
  token: string,
  id: string,
  policyAttributes: ApiPolicyAttribute[],
): Promise<ApiDirectoryUser> {
  const body = await request<{ user: ApiDirectoryUser }>(
    `/users/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ policyAttributes }),
    },
  );
  return body.user;
}

/**
 * POST /users/:id/resend-invite — re-issue a pending invite link.
 *
 * Returns the RAW token alongside the new invite record. That is the only way the
 * console can offer a copyable link: only the token's hash is persisted, so an
 * outstanding link can never be read back — a re-issue is what surfaces one. The
 * server narrows this to the caller's administered organizations, so the token
 * goes to the party already able to issue invites for the address.
 */
export function resendInvite(
  token: string,
  id: string,
): Promise<{
  status: string;
  invite: { id: string; email: string; expiresAt: string };
  token: string;
}> {
  return request<{
    status: string;
    invite: { id: string; email: string; expiresAt: string };
    token: string;
  }>(`/users/${encodeURIComponent(id)}/resend-invite`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

/** POST /auth/invite — create an account invitation (PBAC `admin` on `users`). */
export async function inviteUser(
  token: string,
  body: {
    email: string;
    organizationId: string;
    policyAttributes: ApiPolicyAttribute[];
  },
): Promise<{ invite: { id: string; email: string; expiresAt: string }; token?: string }> {
  return request<{ invite: { id: string; email: string; expiresAt: string }; token?: string }>(
    "/auth/invite",
    { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) },
  );
}

/* -------------------------------------------- deployment configuration |
   The onboarding wizard's whole server surface. Every mutation answers with the
   same read model, so the wizard re-renders from what the server actually stored
   rather than from what it hoped it sent — a form that echoes its own input back
   looks correct even when the write was ignored.

   A SECRET IS NEVER IN A RESPONSE. `getSettings` carries presence and the last
   four characters; there is no field in these types that can hold one. */

/** GET /settings — presence and last-four of each credential, never a value. */
export async function getSettings(token: string): Promise<ApiDeploymentSettings> {
  const body = await request<{ settings: ApiDeploymentSettings }>("/settings", {
    headers: authHeaders(token),
  });
  return body.settings;
}

/**
 * PUT /settings/gateway
 *
 * An ABSENT field is left alone; `null` clears it. That is what lets step 2 ask
 * for a secret only when none is stored yet — an operator cannot read back the one
 * they set last time, so they must not be made to retype it, and an empty box must
 * not silently erase it.
 */
export async function updateGatewaySettings(
  token: string,
  body: { clientId?: string | null; webhookSecret?: string | null },
): Promise<ApiDeploymentSettings> {
  const result = await request<{ settings: ApiDeploymentSettings }>("/settings/gateway", {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return result.settings;
}

/** PUT /settings/adaptor — the chosen accounting system, its realm and credentials. */
export async function updateAdaptorSettings(
  token: string,
  body: {
    id?: ApiAdaptorId | null;
    realmId?: string | null;
    baseUrl?: string | null;
    credentials?: Record<string, string> | null;
  },
): Promise<ApiDeploymentSettings> {
  const result = await request<{ settings: ApiDeploymentSettings }>("/settings/adaptor", {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return result.settings;
}

/**
 * PUT /settings/invoice-matching — the customer matching rule. ADMIN ONLY.
 *
 * Its own endpoint rather than a key on `updateAdaptorSettings`, because the
 * server gates it on `admin` while that one is open to `write` as well. The
 * console hides the control from a non-administrator too, but that is a
 * courtesy: this function is the boundary, and the route is the one that
 * actually refuses.
 */
export async function updateInvoiceMatchingSettings(
  token: string,
  body: {
    strategy?: ApiInvoiceMatchStrategy | null;
    mode?: ApiInvoiceMatchMode | null;
    fieldName?: string | null;
    depositAccountId?: string | null;
  },
): Promise<ApiDeploymentSettings> {
  const result = await request<{ settings: ApiDeploymentSettings }>("/settings/invoice-matching", {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return result.settings;
}

/** PUT /settings/preferences — the deployment's name. */
export async function updatePreferenceSettings(
  token: string,
  body: { organizationName?: string | null; syncInterval?: string | null; alertTarget?: string | null },
): Promise<ApiDeploymentSettings> {
  const result = await request<{ settings: ApiDeploymentSettings }>("/settings/preferences", {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return result.settings;
}

/**
 * POST /settings/adaptor/verify — test the connection.
 *
 * With `credentials` in the body it tests a value that is NOT saved yet and records
 * nothing. Without them it tests what is stored, which is the console's re-verify.
 * Either way a rejection comes back as a 200 carrying `ok: false`, because a wrong
 * password is an answer, not a transport failure.
 */
export async function verifyAdaptor(
  token: string,
  body: {
    id?: ApiAdaptorId;
    realmId?: string;
    baseUrl?: string;
    credentials?: Record<string, string>;
  },
): Promise<ApiAdaptorVerification> {
  const result = await request<{ verification: ApiAdaptorVerification }>(
    "/settings/adaptor/verify",
    { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) },
  );
  return result.verification;
}

/** POST /settings/complete — finish setup. Idempotent. */
export async function completeSettings(token: string): Promise<ApiDeploymentSettings> {
  const result = await request<{ settings: ApiDeploymentSettings }>("/settings/complete", {
    method: "POST",
    headers: authHeaders(token),
  });
  return result.settings;
}

/**
 * GET /settings/adaptor/connect — begin the QuickBooks authorization.
 *
 * Returns a URL FOR THE CALLER TO NAVIGATE TO, rather than redirecting itself,
 * because this endpoint requires a bearer token and a browser navigation does not
 * send one. A 302 here is unreachable from a button.
 *
 * The URL carries no secret — `client_id` is public, `redirect_uri` is this
 * deployment's own callback, and `state` is a short-lived signed nonce.
 */
export async function beginQuickBooksConnect(token: string): Promise<string> {
  const result = await request<{ authorizationUrl: string }>("/settings/adaptor/connect", {
    headers: authHeaders(token),
  });
  return result.authorizationUrl;
}