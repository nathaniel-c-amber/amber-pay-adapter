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
    /* Kept as the ISO instant the backend sent. Formatting belongs to the view
       (`@/utils/datetime`), not the mapper: a display string is un-sortable, and
       the event table's Time column sorts on this value. */
    at: e.at,
    type: e.type,
    channel: e.channel,
    ref: e.ref,
    detail: e.detail,
  };
}

export function mapFailure(f: ApiFailure): Failure {
  const failure: Failure = {
    id: f.id,
    severity: f.severity,
    channel: f.channel,
    title: f.title,
    detail: f.detail,
    /* ISO instant, as with `at` above — see the note there. */
    since: f.since,
  };
  /*
    Acknowledgement is read here, deliberately. This mapper used to drop
    `acknowledgedAt` entirely, which meant the server's acknowledgement was
    written but never reached any view: the console tracked its own in-memory
    set of "acked" ids, that set reset on every page load, and so an
    acknowledged finding reappeared for every operator including the one who
    had just acknowledged it. The two fields are now part of the mapped shape
    and the UI derives its state from them.

    Both are copied only when present, so an unacknowledged finding stays
    genuinely absent rather than becoming a defined `undefined`.
  */
  if (f.acknowledgedAt) {
    failure.acknowledgedAt = f.acknowledgedAt;
  }
  if (f.acknowledgedBy) {
    failure.acknowledgedBy = f.acknowledgedBy;
  }
  return failure;
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