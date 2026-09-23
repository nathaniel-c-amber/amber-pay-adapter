/* Minimal typed API client for the Amber Pay Ledger backend.
   Uses fetch. All endpoints are under /api/v1. */

import type {
  ApiDirectoryUser,
  ApiIdentity,
  ApiInviteDetail,
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

/** POST /failures/:id/acknowledge — persists an acknowledgement (Bearer token). */
export function acknowledgeFailure(token: string, id: string): Promise<void> {
  return request<void>(`/failures/${encodeURIComponent(id)}/acknowledge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
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

/** POST /users/:id/resend-invite — re-issue a pending invite link. */
export function resendInvite(token: string, id: string): Promise<{ status: string }> {
  return request<{ status: string }>(
    `/users/${encodeURIComponent(id)}/resend-invite`,
    { method: "POST", headers: authHeaders(token) },
  );
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