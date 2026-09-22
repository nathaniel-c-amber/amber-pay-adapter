/* Token store + auth helpers. The access token is persisted in localStorage so
   a refresh keeps the session.

   SECURITY NOTE (m1): localStorage is readable by any script running on the
   origin, so a stored token is exposed to XSS. This is an accepted tradeoff
   for a monitoring console. The token is short-lived (≤1h, per the backend
   JWT_TTL) and is cleared on any 401, which bounds the blast radius. Do not
   store long-lived credentials here. */

import { verifyTwoFactor } from "./client";

const TOKEN_KEY = "amber.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Verify the 2FA code for an existing challenge and store the issued token. */
export async function verifyAndStoreToken(
  challengeId: string,
  code: string,
): Promise<string> {
  const { accessToken } = await verifyTwoFactor(challengeId, code);
  setToken(accessToken);
  return accessToken;
}