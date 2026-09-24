/**
 * Stage-flow view model.
 *
 * Translates the backend's stage aggregate into the console's display model.
 * The backend owns the counts, the thresholds and the per-stage state; this
 * module only names things and derives presentation facts. It never
 * recomputes counts from the event list — that list is a capped window, and a
 * count derived from it would be a partial number presented as a total.
 */

import type { ApiStageFlow, ApiStageFlowSummary, FlowStage, StageState } from "@/types/api";

export const STAGE_SEQUENCE: readonly FlowStage[] = [
  "initiated",
  "collected",
  "ingested",
  "posted",
];

export const STAGE_LABEL: Record<FlowStage, string> = {
  initiated: "Initiated",
  collected: "Collected",
  ingested: "Ingested",
  posted: "Posted",
};

/**
 * The lifecycle event types each stage is derived from. Mirrors STAGE_OF_EVENT
 * in the backend aggregate so a drill-through filters to exactly the events the
 * stage was computed from — if these two ever disagree, the spine and the log
 * would tell different stories about the same payment.
 */
export const STAGE_EVENT_TYPES: Record<FlowStage, readonly string[]> = {
  initiated: ["initiated"],
  collected: ["collected"],
  ingested: ["webhook-received"],
  posted: ["record-updated"],
};

export function isFlowStage(value: string | null | undefined): value is FlowStage {
  return value === "initiated" || value === "collected" || value === "ingested" || value === "posted";
}

/**
 * What each stage means operationally, in the operator's terms rather than the
 * pipeline's. Shown on the stage cell so the spine needs no separate legend.
 */
export const STAGE_MEANING: Record<FlowStage, string> = {
  initiated: "Payment created at the gateway",
  collected: "Funds collected",
  ingested: "Webhook accepted by the adaptor",
  posted: "Invoice recorded in the accounting system",
};

export type FlowHealth = "healthy" | "degraded" | "failed" | "blind";

export const FLOW_HEALTH_LABEL: Record<FlowHealth, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failed: "Failed",
  blind: "Blind",
};

/** Worst stage state wins, so a single failed stage cannot hide behind three good ones. */
export function aggregateFlowHealth(stages: ApiStageFlow[]): FlowHealth {
  if (stages.length === 0) return "blind";
  const reporting = stages.filter((s) => !s.notReporting);
  if (reporting.length === 0) return "blind";
  if (reporting.some((s) => s.state === "failed")) return "failed";
  if (reporting.some((s) => s.state === "degraded")) return "degraded";
  if (reporting.some((s) => s.state === "not-reporting")) return "degraded";
  return "healthy";
}

export function stagesNotReporting(stages: ApiStageFlow[]): number {
  return stages.filter((s) => s.notReporting).length;
}

/** Total items waiting anywhere in the pipeline (halted items excluded). */
export function totalInFlight(stages: ApiStageFlow[]): number {
  return stages.reduce((n, s) => n + s.inFlight, 0);
}

export function totalFailed(stages: ApiStageFlow[]): number {
  return stages.reduce((n, s) => n + s.failed, 0);
}

/** Humanised duration from milliseconds. Compact, mono-friendly. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Age of a timestamp, for "oldest waiting item" style readouts. */
export function formatAge(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const ms = now.getTime() - t;
  if (ms < 0) return "now";
  return formatDuration(ms);
}

/**
 * How far a stage's dwell sits against its own fail threshold, as a 0..1
 * fraction used to size the bar. Capped at 1: a stage 40x over target must not
 * render as an unbounded stripe, and the overflow is signalled by the bar
 * stopping short and growing a hatch instead.
 */
export function dwellFraction(stage: ApiStageFlow): number {
  if (stage.dwellP95Ms === null) return 0;
  const span = stage.thresholds.failMs;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, stage.dwellP95Ms / span));
}

/**
 * Where this stage's TARGET sits on the same 0..1 scale as `dwellFraction`.
 *
 * Without this marker the bars are unreadable: every healthy stage collapses to
 * a hairline at the left edge, so "1.1s against a 30s target" and "2m against a
 * 1m target" look identical. With the marker drawn, the reading is the
 * relationship — the fill sits left of the target, or crosses it — which works
 * even when the absolute lengths are tiny.
 */
export function targetFraction(stage: ApiStageFlow): number {
  const span = stage.thresholds.failMs;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, stage.thresholds.warnMs / span));
}

export function isOverThreshold(stage: ApiStageFlow): boolean {
  return stage.dwellP95Ms !== null && stage.dwellP95Ms > stage.thresholds.warnMs;
}

/** Ratio of items that entered a stage and advanced, for the stage's pass rate. */
export function advanceRate(stage: ApiStageFlow): number | null {
  if (stage.entered === 0) return null;
  return (stage.exited + stage.completed) / stage.entered;
}

/* --------------------------------------------------------------- deltas */

export interface StageDelta {
  stage: FlowStage;
  label: string;
  /** Change in p95 dwell between the previous snapshot and now, in ms. */
  dwellDeltaMs: number | null;
  /** Change in total in-flight between the previous snapshot and now. */
  inFlightDelta: number;
  /** Change in failures. */
  failedDelta: number;
  tone: "improved" | "steady" | "worse";
}

export interface FlowComparison {
  /** When the previous snapshot was taken. */
  since: string;
  deltas: StageDelta[];
  /** True when nothing moved beyond noise. */
  steady: boolean;
}

/** Dwell movement smaller than this is noise, not a trend. */
const DWELL_NOISE_MS = 250;

/**
 * Compare two stage summaries.
 *
 * This is the "what changed" panel: a single poll tells you where things are,
 * but only a comparison tells you whether it is getting worse — which is the
 * question an operator asks second and the console previously could not
 * answer at all.
 */
export function compareFlows(
  previous: ApiStageFlowSummary,
  current: ApiStageFlowSummary,
): FlowComparison {
  const before = new Map(previous.stages.map((s) => [s.stage, s]));
  const deltas: StageDelta[] = [];

  for (const stage of current.stages) {
    const prev = before.get(stage.stage);
    const label = STAGE_LABEL[stage.stage];
    if (!prev) {
      deltas.push({
        stage: stage.stage,
        label,
        dwellDeltaMs: null,
        inFlightDelta: stage.inFlight,
        failedDelta: stage.failed,
        tone: stage.inFlight > 0 || stage.failed > 0 ? "worse" : "steady",
      });
      continue;
    }

    const dwellDeltaMs =
      stage.dwellP95Ms !== null && prev.dwellP95Ms !== null
        ? stage.dwellP95Ms - prev.dwellP95Ms
        : null;
    const inFlightDelta = stage.inFlight - prev.inFlight;
    const failedDelta = stage.failed - prev.failed;

    let tone: StageDelta["tone"] = "steady";
    if (failedDelta > 0 || (dwellDeltaMs !== null && dwellDeltaMs > DWELL_NOISE_MS)) {
      tone = "worse";
    } else if (failedDelta < 0 || (dwellDeltaMs !== null && dwellDeltaMs < -DWELL_NOISE_MS)) {
      tone = "improved";
    }

    deltas.push({ stage: stage.stage, label, dwellDeltaMs, inFlightDelta, failedDelta, tone });
  }

  return {
    since: previous.computedAt,
    deltas,
    steady: deltas.every((d) => d.tone === "steady"),
  };
}

/** Human-readable dwell movement, e.g. "+2m 01s" / "−0.4s". */
export function formatDeltaMs(ms: number | null): string {
  if (ms === null) return "—";
  if (Math.abs(ms) < 1) return "±0";
  const sign = ms > 0 ? "+" : "−";
  return `${sign}${formatDuration(Math.abs(ms))}`;
}

export const STAGE_STATE_LABEL: Record<StageState, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failed: "Failed",
  "not-reporting": "Not reporting",
};
