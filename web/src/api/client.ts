/* Minimal typed API client for the Amber Pay backend.
   Uses fetch. All endpoints are under /api/v1. */

import type { MetricsResponse } from "./types";

export const apiBaseUrl: string =
  import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

/** Thrown when the API returns 401 (missing/expired/invalid token). */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
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
    if (res.status === 401) {
      throw new UnauthorizedError();
    }
    throw new Error(`Request failed (${res.status})`);
  }

  return (await res.json()) as T;
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

/** POST /auth/2fa/verify — verifies the code and returns an access token. */
export async function verifyTwoFactor(
  challengeId: string,
  code: string,
): Promise<{ accessToken: string }> {
  return request<{ accessToken: string }>("/auth/2fa/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId, code }),
  });
}