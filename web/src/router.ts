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
  | "reset";

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
    "signin", "invite", "forgot", "reset",
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
