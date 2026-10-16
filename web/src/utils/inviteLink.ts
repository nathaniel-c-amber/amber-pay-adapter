/* The shareable invitation link.
 *
 * MIRRORS the server's `inviteUrl` (`server/src/services/shared/email/templates.ts`).
 * The console is a hash router and `invite` is a detail route, so the token is a
 * path segment of the HASH — `#/invite/<token>` — which `router.ts` resolves and
 * which the `/accept-invite` path alias adopts on entry. A copy action, the
 * emailed link and the router must all agree on that shape: a link an
 * administrator pastes into a chat has to land on the accept page, not on the
 * overview, which is exactly what a `?token=` link would do here.
 *
 * `baseUrl` is the console's public origin (optionally including a sub-path). A
 * trailing slash is tolerated so `${origin}/` and `${origin}` behave identically,
 * and the token is percent-encoded because it is a path segment, not a query
 * value — an un-encoded `/` or space would silently split or truncate it.
 */
export function inviteLink(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/#/invite/${encodeURIComponent(token)}`;
}
