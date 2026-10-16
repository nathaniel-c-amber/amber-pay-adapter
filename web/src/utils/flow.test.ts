import { describe, it, expect } from "vitest";
import {
  STAGE_EVENT_TYPES,
  STAGE_SEQUENCE,
  aggregateFlowHealth,
  dwellFraction,
  formatAge,
  formatDuration,
  isFlowStage,
  stagesNotReporting,
  totalFailed,
  totalInFlight,
} from "@/utils/flow";
import type { ApiStageFlow, StageState } from "@/types/api";

/** A stage in a named state, with everything else healthy. */
const stage = (over: Partial<ApiStageFlow> = {}): ApiStageFlow => ({
  stage: "collected",
  state: "healthy",
  entered: 10,
  inFlight: 2,
  exited: 8,
  completed: 7,
  failed: 0,
  oldestInFlightAt: null,
  dwellP95Ms: 1000,
  sampleSize: 10,
  thresholds: { warnMs: 5000, failMs: 30000 },
  notReporting: false,
  ...over,
});

const silent = (): ApiStageFlow => stage({ state: "not-reporting", notReporting: true });

describe("the stage vocabulary", () => {
  it("has four stages in pipeline order", () => {
    expect(STAGE_SEQUENCE).toEqual(["initiated", "collected", "ingested", "posted"]);
  });

  /*
    These mirror `STAGE_OF_EVENT` in the backend aggregate. If they drift, the
    flow spine and the drill-through event filter tell different stories about
    the same payment — a backend change must update BOTH sides.
  */
  it("maps every stage to at least one event type", () => {
    for (const name of STAGE_SEQUENCE) {
      expect(STAGE_EVENT_TYPES[name].length).toBeGreaterThan(0);
    }
  });

  it("does not share an event type between stages", () => {
    const seen = new Set<string>();
    for (const name of STAGE_SEQUENCE) {
      for (const type of STAGE_EVENT_TYPES[name]) {
        expect(seen.has(type), `${type} is claimed by two stages`).toBe(false);
        seen.add(type);
      }
    }
  });

  it("narrows only real stage names", () => {
    expect(isFlowStage("posted")).toBe(true);
    expect(isFlowStage("declined")).toBe(false);
    expect(isFlowStage(null)).toBe(false);
    expect(isFlowStage(undefined)).toBe(false);
  });
});

describe("aggregateFlowHealth", () => {
  it("is blind, not healthy, when nothing reports", () => {
    // Silence is never health: an empty or wholly non-reporting spine must not
    // render as a clean bill of health.
    expect(aggregateFlowHealth([])).toBe("blind");
    expect(aggregateFlowHealth([silent()])).toBe("blind");
  });

  it("lets the worst reporting stage win", () => {
    expect(aggregateFlowHealth([stage(), stage({ state: "degraded" })])).toBe("degraded");
    expect(aggregateFlowHealth([stage({ state: "degraded" }), stage({ state: "failed" })])).toBe(
      "failed",
    );
  });

  /*
    A SILENT STAGE DOES NOT DEGRADE THE SPINE — and that is deliberate.

    The roll-up describes the stages that ARE reporting; a stage nobody reached
    is surfaced on its own cell (and by `stagesNotReporting`) instead. Were it
    rolled in, a deployment whose `posted` stage has seen no payments yet would
    read permanently amber, which is worse than useless on a fresh install.

    The backend always pairs `notReporting: true` with `state: 'not-reporting'`
    (`stageFlow.service.ts:202`), so the `not-reporting` branch inside
    `aggregateFlowHealth` is only reachable from a server that pairs them
    inconsistently — defensive, not dead.
  */
  it("leaves the roll-up healthy when a healthy stage sits beside a silent one", () => {
    expect(aggregateFlowHealth([stage(), silent()])).toBe("healthy");
    expect(stagesNotReporting([stage(), silent()])).toBe(1);
  });

  it("is healthy only when every stage reports and none is degraded", () => {
    expect(aggregateFlowHealth([stage(), stage({ stage: "posted" })])).toBe("healthy");
  });

  it("accounts for every state the type declares", () => {
    // A state added to the union without a branch here would otherwise fall
    // through to "healthy" silently.
    const states: StageState[] = ["healthy", "degraded", "failed", "not-reporting"];
    for (const state of states) {
      expect(aggregateFlowHealth([stage({ state })])).not.toBe("blind");
    }
  });
});

describe("stage totals", () => {
  it("sums in-flight across stages and counts silent stages", () => {
    const stages = [
      stage({ inFlight: 2 }),
      stage({ stage: "posted", inFlight: 3, state: "not-reporting", notReporting: true }),
    ];
    expect(totalInFlight(stages)).toBe(5);
    expect(stagesNotReporting(stages)).toBe(1);
    expect(totalFailed([stage({ failed: 2 }), stage({ failed: 1 })])).toBe(3);
  });

  it("returns zero, not NaN, for an empty spine", () => {
    expect(totalInFlight([])).toBe(0);
    expect(totalFailed([])).toBe(0);
    expect(stagesNotReporting([])).toBe(0);
  });
});

describe("dwellFraction", () => {
  it("is zero when there is no dwell reading", () => {
    expect(dwellFraction(stage({ dwellP95Ms: null }))).toBe(0);
  });

  it("is zero when the fail threshold is not a usable span", () => {
    expect(dwellFraction(stage({ thresholds: { warnMs: 1, failMs: 0 } }))).toBe(0);
  });

  it("caps at 1 so a 40x overrun cannot render as an unbounded bar", () => {
    const s = stage({ dwellP95Ms: 1200000, thresholds: { warnMs: 5000, failMs: 30000 } });
    expect(dwellFraction(s)).toBe(1);
  });

  it("never goes negative on a clock-skewed reading", () => {
    expect(dwellFraction(stage({ dwellP95Ms: -5000 }))).toBe(0);
  });

  it("reports a fraction of the fail threshold", () => {
    const s = stage({ dwellP95Ms: 15000, thresholds: { warnMs: 5000, failMs: 30000 } });
    expect(dwellFraction(s)).toBeCloseTo(0.5);
  });
});

describe("formatDuration", () => {
  it("renders sub-second, second, minute and hour scales", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
  });

  it("is an em dash rather than NaN for an absent reading", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatAge", () => {
  const now = new Date("2026-10-06T12:00:00.000Z");

  it("measures back from the supplied clock", () => {
    expect(formatAge("2026-10-06T11:58:30.000Z", now)).toBe("1m 30s");
  });

  it("reads as now for a future instant rather than a negative age", () => {
    expect(formatAge("2026-10-06T12:05:00.000Z", now)).toBe("now");
  });

  it("is an em dash for absent or unusable input", () => {
    expect(formatAge(null, now)).toBe("—");
    expect(formatAge("not-a-date", now)).toBe("—");
  });
});
