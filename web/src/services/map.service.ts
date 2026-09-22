/* Mapping layer: backend API shapes (types/api.ts) → frontend display
   shapes (types/domain.ts). The frontend components render unchanged;
   this layer only supplies the fields they expect (color, segments) and
   strips backend-only fields (organizationId, acknowledgedAt).

   Color derivation (deterministic):
   - terminus wins: quickbooks→scarlet, sage→amber, amber-pay→cobalt,
     audit-trail→green.
   - unknown terminus falls back by status: open/arriving→green,
     delayed→amber, suspended→scarlet.

   Segments (deterministic default pattern per status, mirroring the original
   fixture feel): open/arriving run clean, delayed shows a mid-run dip, and a
   suspended line visibly breaks toward the terminus. */

import type {
  ApiFailure,
  ApiLifecycleEvent,
  ApiPolicyScope,
  ApiStageFlowSummary,
  ConnectorState,
  MetricsResponse,
} from "@/types/api";
import type {
  Connector,
  Failure,
  LifecycleEvent,
  PolicyScope,
} from "@/types/domain";

const TERMINUS_COLOR: Record<ConnectorState["terminus"], Connector["color"]> = {
  quickbooks: "scarlet",
  sage: "amber",
  "amber-pay": "cobalt",
  "audit-trail": "green",
};

const STATUS_COLOR: Record<ConnectorState["status"], Connector["color"]> = {
  open: "green",
  arriving: "green",
  delayed: "amber",
  suspended: "scarlet",
};

const STATUS_SEGMENTS: Record<ConnectorState["status"], number[]> = {
  open: [5, 5, 5, 5, 5, 5, 5],
  arriving: [5, 5, 5, 5, 5, 5, 5],
  delayed: [4, 4, 5, 4, 4, 7, 6],
  suspended: [5, 5, 4, 4, 0, 0, 0],
};

/** Safe default segment pattern when the status is unknown (m4). */
const DEFAULT_SEGMENTS = [5, 5, 5, 5, 5, 5, 5];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Format a timestamp for display. The backend returns ISO 8601; the frontend
 * tables expect compact clock strings. If the value is already a compact clock
 * string (no date separators), it is passed through unchanged.
 * - formatClock → "HH:MM:SS" (event stream Time column)
 * - formatTime  → "HH:MM"   (findings Since column)
 */
export function formatClock(value: string): string {
  if (value.includes("T") || value.includes("-")) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
  }
  return value;
}

export function formatTime(value: string): string {
  if (value.includes("T") || value.includes("-")) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  return value;
}

export function mapConnector(c: ConnectorState): Connector {
  return {
    id: c.id,
    label: c.label,
    terminus: c.terminus,
    color: TERMINUS_COLOR[c.terminus] ?? STATUS_COLOR[c.status],
    status: c.status,
    reading: c.reading,
    note: c.note,
    segments: STATUS_SEGMENTS[c.status] ?? DEFAULT_SEGMENTS,
  };
}

export function mapEvent(e: ApiLifecycleEvent): LifecycleEvent {
  return {
    id: e.id,
    at: formatClock(e.at),
    type: e.type,
    channel: e.channel,
    ref: e.ref,
    detail: e.detail,
  };
}

export function mapFailure(f: ApiFailure): Failure {
  return {
    id: f.id,
    severity: f.severity,
    channel: f.channel,
    title: f.title,
    detail: f.detail,
    since: formatTime(f.since),
  };
}

export function mapPolicy(p: ApiPolicyScope): PolicyScope {
  return {
    id: p.id,
    label: p.label,
    attributes: Object.entries(p.attributes)
      .map(([k, v]) => `${k}:${v}`)
      .join("|"),
    readOnly: p.readOnly,
  };
}

export interface MappedMetrics {
  connectors: Connector[];
  events: LifecycleEvent[];
  failures: Failure[];
  policies: PolicyScope[];
  /**
   * Authoritative flow aggregate. Passed through unchanged rather than
   * re-modelled: the backend owns the counts and thresholds, and the console
   * must quote the same numbers the backend judged against. Undefined only
   * when the server predates the aggregate.
   */
  stages?: ApiStageFlowSummary;
  generatedAt: string;
}

export function mapMetrics(m: MetricsResponse): MappedMetrics {
  return {
    connectors: m.connectors.map(mapConnector),
    events: m.events.map(mapEvent),
    failures: m.failures.map(mapFailure),
    policies: m.policies.map(mapPolicy),
    stages: m.stages,
    generatedAt: m.generatedAt,
  };
}