/* A tiny hash router for the console.
 *
 * The redesign brief names concrete routes (/overview, /connections/:id,
 * /findings/:id, /events, /synchronization, /reconciliation, /payments,
 * /users, /settings, /profile) and requires every major status to be
 * drillable. Rather than add a routing dependency, this module maps those
 * paths onto <hash> so deep links, the browser back button, and shareable
 * URLs all work, and the app shell can derive its navigation state from one
 * source of truth.
 *
 * Route strings are the *canonical* paths (no leading slash):
 *   overview · connections · connections/:id · findings · findings/:id ·
 *   events · events/:stage · payments · synchronization · reconciliation ·
 *   users · settings · profile · signin · invite/:token · forgot · reset/:token
 */

import { useCallback, useSyncExternalStore } from "react";

export type RouteName =
  | "overview"
  | "connections"
  | "findings"
  | "events"
  | "payments"
  | "synchronization"
  | "reconciliation"
  | "users"
  | "settings"
  | "profile"
  /* Unauthenticated surfaces. They live in the same router so an invite link is
     a shareable URL and the back button works, but they render outside the
     console shell — see Shell.tsx. */
  | "signin"
  | "invite"
  /* Credential recovery. Both are reachable with no session, and `reset`
     carries the single-use token as its path param so the emailed link is a
     plain deep link. */
  | "forgot"
  | "reset"
  /* First-run setup. Signed in, but rendered outside the console chrome: a
     deployment with no gateway and no accounting system has no pipeline to
     monitor, so framing this as a console page would put empty panels around it. */
  | "onboarding";

export interface Route {
  name: RouteName;
  /**
   * The second path segment: an id for connections/:id and findings/:id, or a
   * stage for events/:stage.
   */
  param: string | null;
  /** The canonical path, e.g. "connections/sage". */
  path: string;
}

/* Routes that accept a second path segment. `events` carries a stage filter
   (events/ingested) so a stage in the flow spine can drill through to exactly
   the events that stage is derived from, rather than dumping the operator into
   an unfiltered log and leaving them to re-create the filter by hand. */
const DETAIL_ROUTES: RouteName[] = ["connections", "findings", "events", "invite", "reset"];

function parse(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  const head = parts[0] ?? "overview";
  const param = parts[1] ?? null;
  const isDetail = param !== null && (DETAIL_ROUTES as string[]).includes(head);
  const name = (isDetail ? head : head) as RouteName;
  // Normalise unknown first segments back to the overview so a bad hash
  // never renders an empty page.
  const known: string[] = [
    "overview", "connections", "findings", "events", "payments",
    "synchronization", "reconciliation", "users", "settings", "profile",
    "signin", "invite", "forgot", "reset", "onboarding",
  ];
  if (!known.includes(name)) {
    return { name: "overview", param: null, path: "overview" };
  }
  return {
    name,
    param: isDetail ? param : null,
    path: isDetail ? `${name}/${param}` : name,
  };
}

/*
  The server emails links in the PATH form, with the secret in the query string
  (`${APP_BASE_URL}/accept-invite?token=…`), not the hash form this router reads.
  nginx's SPA fallback happily serves index.html for that path, so the request
  arrives with an empty hash — which parses as "overview". An invitee with no
  session was therefore sent to sign-in and the invite page was unreachable from
  the only link that leads to it.

  Adopting the path form on entry fixes that without asking the email to carry a
  `#`, which is the first thing a mail client is liable to mangle. Any real hash
  wins over the alias, so both link shapes work.
*/
const PATH_ALIASES: Record<string, RouteName> = {
  "accept-invite": "invite",
  "reset-password": "reset",
};

function adoptPathFormLink(): void {
  if (window.location.hash) return;
  const segment = window.location.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  const name = PATH_ALIASES[segment];
  if (!name) return;

  // The token moves into the hash, so the query string is dropped rather than
  // left behind as a stale second copy of a single-use secret.
  const url = new URL(window.location.href);
  const token = new URLSearchParams(url.search).get("token");
  url.search = "";
  url.hash = token ? `/${name}/${token}` : `/${name}`;
  // replaceState, not pushState: the tidied URL is the one this page load means,
  // so going back should leave the flow rather than bounce through the alias.
  window.history.replaceState(null, "", url);
}

adoptPathFormLink();

function currentPath(): string {
  return window.location.hash.replace(/^#\/?/, "") || "overview";
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

function getSnapshot(): string {
  return currentPath();
}

/** Navigate imperatively (used by click handlers and programmatic redirects). */
export function navigate(name: RouteName, param?: string | null): void {
  const path = param ? `${name}/${param}` : name;
  if (currentPath() !== path) {
    window.location.hash = `/${path}`;
  }
}

/** The active route, re-rendered on every hash change. */
export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, getSnapshot, () => "overview");
  return parse(path);
}

/** A stable navigate callback bound to no particular route. */
export function useNavigate(): (name: RouteName, param?: string | null) => void {
  return useCallback((name: RouteName, param?: string | null) => navigate(name, param), []);
}
