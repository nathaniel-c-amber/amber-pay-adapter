/* Operational vocabulary for the monitor console.
 *
 * The redesign brief requires a single, consistent health language and a
 * separate severity language. The backend still reports connector state as
 * open / arriving / delayed / suspended; this module is the ONE place that
 * translates those wire values into the operator-facing terms used across
 * every surface, so no screen invents its own wording.
 *
 *   Health    (what a connection is doing):  Healthy · Degraded · Failed · Stopped · Unknown
 *   Severity  (how much it matters):         Critical · Warning · Info
 *
 * Health and severity are deliberately orthogonal: a connection is Failed
 * (health) and the finding it raises is Critical (severity). */

import type { LineStatus, Severity } from "@/types/domain";

export type Health = "healthy" | "degraded" | "failed" | "stopped" | "unknown";

/** Connector wire status → operator health term. */
export const HEALTH_OF: Record<LineStatus, Health> = {
  open: "healthy",
  arriving: "healthy",
  delayed: "degraded",
  suspended: "failed",
};

export const HEALTH_LABEL: Record<Health, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "Unknown",
};

/** Plain-language operational impact per health, used in banners and rows. */
export const HEALTH_IMPACT: Record<Health, string> = {
  healthy: "Carrying traffic normally.",
  degraded: "Carrying traffic, but behind its expected schedule.",
  failed: "Not processing events. Incoming traffic is queued.",
  stopped: "Disabled by configuration. No traffic is expected.",
  unknown: "State not reported.",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  attention: "Warning",
};

/** Highest health tone wins for an aggregate of connections. */
export function aggregateHealth(statuses: LineStatus[]): Health {
  const healths = statuses.map((s) => HEALTH_OF[s]);
  if (healths.includes("failed")) return "failed";
  if (healths.includes("degraded")) return "degraded";
  if (healths.every((h) => h === "healthy")) return "healthy";
  return "unknown";
}

/** Count of connections in each health bucket. */
export function healthCounts(statuses: LineStatus[]): Record<Health, number> {
  const out: Record<Health, number> = {
    healthy: 0,
    degraded: 0,
    failed: 0,
    stopped: 0,
    unknown: 0,
  };
  for (const s of statuses) out[HEALTH_OF[s]] += 1;
  return out;
}
