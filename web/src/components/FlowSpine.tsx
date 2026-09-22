/**
 * FlowSpine — the Overview's hero.
 *
 * The console used to answer "are my integrations up?" with four flat KPI tiles
 * and a topology diagram. This answers the question an operator actually has:
 * WHERE ARE PAYMENTS SITTING, AND IS THAT NORMAL?
 *
 * Structure and accessibility:
 *  - It is a real <table>: attributes are rows, stages are columns. Header
 *    cells name the stage, so assistive tech announces each reading in context
 *    ("Dwell p95, Ingested, 2m 01s") and the bars stay purely decorative. A
 *    chart that exists only as pixels is unreadable to AT; that can't happen here.
 *  - Every state carries a word plus a number, never a colour or a bar length
 *    alone.
 *  - Bars are capped at their stage's fail threshold. A stage 40x over target
 *    must not paint an unbounded stripe, so it stops at the cap and grows a
 *    hatch — the same "beyond normal" grammar the rest of the console uses.
 */

import type { ApiStageFlowSummary, FlowStage, StageState } from "@/types/api";
import {
  STAGE_LABEL,
  STAGE_MEANING,
  STAGE_STATE_LABEL,
  advanceRate,
  dwellFraction,
  formatAge,
  formatDuration,
  isOverThreshold,
  targetFraction,
} from "@/utils/flow";
import type { FlowComparison } from "@/utils/flow";
import {
  IconFlowArrow,
  IconStageCollected,
  IconStageIngested,
  IconStageInitiated,
  IconStagePosted,
} from "./icons";
import { cx } from "./ui";

const STAGE_ICON: Record<FlowStage, React.ComponentType<{ size?: number | string }>> = {
  initiated: IconStageInitiated,
  collected: IconStageCollected,
  ingested: IconStageIngested,
  posted: IconStagePosted,
};

/* Each stage state carried FOUR declarations in the old sheet (ink, surface,
   border colour, and — for not-reporting — a dashed border). A lookup keeps all
   four together so a new state cannot arrive half-painted. */
const STAGE_STATE: Record<StageState, string> = {
  healthy: "text-line-green bg-[rgb(57_185_138/0.12)] border-[rgb(57_185_138/0.32)]",
  degraded: "text-state-delayed bg-state-tint-delayed border-[rgb(251_191_36/0.32)]",
  failed: "text-text-suspended bg-state-tint-suspended border-[rgb(248_113_113/0.34)]",
  "not-reporting": "text-ink-3 border-rule-enamel border-dashed",
};

/* The delta chip's two live tones; `steady` rows never render. */
const DELTA_TONE: Record<"improved" | "steady" | "worse", string> = {
  worse: "text-text-suspended bg-state-tint-suspended",
  improved: "text-line-green bg-[rgb(57_185_138/0.12)]",
  steady: "",
};

const pct = (n: number): string => `${Math.round(n * 100)}%`;

export function FlowSpine({
  summary,
  comparison,
  now,
  onDrill,
  notReporting,
}: {
  summary: ApiStageFlowSummary;
  comparison: FlowComparison | null;
  now: Date;
  onDrill: (stage: FlowStage) => void;
  /** Stages the console could not get status for at all. */
  notReporting: number;
}) {
  const stages = summary.stages;
  const waitingTotal = stages
    .filter((s) => s.stage !== "posted")
    .reduce((n, s) => n + s.inFlight, 0);

  return (
    <div className="overflow-hidden rounded-panel border border-rule-enamel bg-midnight-2 shadow-panel">
      {/* The table keeps all four stages in one view because comparing stage to
          stage is the whole point; on a narrow screen that comparison needs
          horizontal room, so the table scrolls inside a pinned-label frame
          rather than being split into four unconnected cards. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse max-2xl:min-w-[620px] max-md:min-w-[560px]">
        <caption className="caption-top max-w-[92ch] px-4 pt-3 pb-2 text-left text-sm text-ink-2 [&_strong]:text-ink-1 max-md:text-xs">
          Payment flow by stage, from gateway initiation to the accounting record.
          {summary.mayBeTruncated && (
            <>
              {" "}
              Counts are <strong>sampled</strong> from the most recent{" "}
              {summary.eventsConsidered.toLocaleString()} events, so an item whose later event falls
              outside that window can appear to be waiting when it is not.
            </>
          )}
        </caption>

        <thead>
          <tr>
            <td className="w-[108px]" />
            {stages.map((stage, index) => {
              const StageIcon = STAGE_ICON[stage.stage];
              return (
                <th
                  scope="col"
                  key={stage.stage}
                  className="border-b border-rule-enamel px-4 py-3 text-left align-bottom max-md:px-3 max-md:pt-2 max-md:pb-3"
                >
                  <span className="flex items-center gap-2 text-ink-1">
                    <StageIcon size={18} />
                    <span className="text-lg font-semibold">{STAGE_LABEL[stage.stage]}</span>
                    {index < stages.length - 1 && (
                      <span className="ml-auto text-ink-3" aria-hidden>
                        <IconFlowArrow size={14} />
                      </span>
                    )}
                  </span>
                  <span className="mt-1.5 block text-xs font-regular leading-snug text-ink-3">{STAGE_MEANING[stage.stage]}</span>
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {/* State. The drill-through lives here: clicking a stage opens the
              event log filtered to it, so the spine is an index, not a dead end. */}
          <tr className="[&:last-child>*]:border-b-0">
            <th
              scope="row"
              className="sticky left-0 z-2 border-r border-b border-rule-enamel-soft bg-midnight-2 px-4 py-3 text-left align-top text-micro font-semibold uppercase tracking-label text-ink-3 max-md:px-3"
            >
              State
            </th>
            {stages.map((stage) => (
              <td
                key={stage.stage}
                className="border-b border-l border-rule-enamel-soft px-4 py-3 align-top first-of-type:border-l-0 max-md:px-3"
              >
                <button
                  type="button"
                  className={cx(
                    "inline-flex cursor-pointer items-center gap-2 rounded-chip border px-2 py-1 text-xs font-semibold hover:border-ink-3 hover:text-ink-1",
                    STAGE_STATE[stage.state],
                  )}
                  onClick={() => onDrill(stage.stage)}
                  aria-label={`${STAGE_LABEL[stage.stage]}: ${STAGE_STATE_LABEL[stage.state]}. ${
                    stage.dwellP95Ms === null
                      ? "No dwell measured"
                      : `Dwell ${formatDuration(stage.dwellP95Ms)}, target ${formatDuration(
                          stage.thresholds.warnMs,
                        )}`
                  }. ${stage.inFlight} waiting. Open the event log filtered to this stage.`}
                >
                  <span className="size-[7px] flex-none rounded-[1px] bg-current" aria-hidden />
                  <span>{STAGE_STATE_LABEL[stage.state]}</span>
                </button>
              </td>
            ))}
          </tr>

          {/* Dwell against target */}
          <tr className="[&:last-child>*]:border-b-0">
            <th
              scope="row"
              className="sticky left-0 z-2 border-r border-b border-rule-enamel-soft bg-midnight-2 px-4 py-3 text-left align-top text-micro font-semibold uppercase tracking-label text-ink-3 max-md:px-3"
            >
              Dwell p95
            </th>
            {stages.map((stage) => {
              const over = isOverThreshold(stage);
              const fraction = dwellFraction(stage);
              const hasValue = stage.dwellP95Ms !== null;
              return (
                <td
                  key={stage.stage}
                  className="border-b border-l border-rule-enamel-soft px-4 py-3 align-top first-of-type:border-l-0 max-md:px-3"
                >
                  <span className={cx("mono block text-xl font-semibold", over ? "text-text-delayed" : "text-ink-1")}>
                    {formatDuration(stage.dwellP95Ms)}
                  </span>
                  <span className="mono mt-1 block text-xs text-ink-3">
                    target ≤ {formatDuration(stage.thresholds.warnMs)}
                  </span>
                  <span className="relative mt-2 block h-1.5 overflow-hidden rounded-[3px] bg-[rgb(148_163_184/0.28)]" aria-hidden>
                    <span
                      className={cx(
                        "block h-full w-full origin-left transition-transform duration-[350ms] ease-[ease-out] motion-reduce:transition-none",
                        over
                          ? "bg-[repeating-linear-gradient(135deg,var(--color-state-delayed)_0_4px,rgb(251_191_36/0.35)_4px_8px)]"
                          : "bg-line-green",
                      )}
                      style={{ transform: `scaleX(${hasValue ? Math.max(fraction, 0.02) : 0})` }}
                    />
                    {/* The stage's own target, drawn as a tick. The reading is
                        where the fill sits relative to this, not its width. */}
                    <span
                      className="absolute -top-0.5 -bottom-0.5 w-px bg-ink-2 opacity-75"
                      style={{ left: `${targetFraction(stage) * 100}%` }}
                    />
                  </span>
                </td>
              );
            })}
          </tr>

          {/* Movement — what is waiting, or what finished */}
          <tr className="[&:last-child>*]:border-b-0">
            <th
              scope="row"
              className="sticky left-0 z-2 border-r border-b border-rule-enamel-soft bg-midnight-2 px-4 py-3 text-left align-top text-micro font-semibold uppercase tracking-label text-ink-3 max-md:px-3"
            >
              Flow
            </th>
            {stages.map((stage) => {
              const isTerminal = stage.stage === "posted";
              const rate = advanceRate(stage);
              const delta = comparison?.deltas.find((d) => d.stage === stage.stage);
              return (
                <td
                  key={stage.stage}
                  className="border-b border-l border-rule-enamel-soft px-4 py-3 align-top first-of-type:border-l-0 max-md:px-3"
                >
                  {stage.notReporting ? (
                    <span className="mono block text-sm text-ink-3">no traffic</span>
                  ) : isTerminal ? (
                    <span className="mono block text-sm text-ink-2 [&_b]:text-ink-1">
                      <b>{stage.completed.toLocaleString()}</b> posted
                      {stage.failed > 0 && (
                        <span className="whitespace-nowrap text-text-suspended"> · {stage.failed} failed</span>
                      )}
                    </span>
                  ) : (
                    <span className="mono block text-sm text-ink-2 [&_b]:text-ink-1">
                      <b>{stage.inFlight.toLocaleString()}</b> waiting
                      {stage.inFlight > 0 && stage.oldestInFlightAt && (
                        <span className="whitespace-nowrap text-ink-3">
                          {" "}
                          · oldest {formatAge(stage.oldestInFlightAt, now)}
                        </span>
                      )}
                      {stage.failed > 0 && (
                        <span className="whitespace-nowrap text-text-suspended"> · {stage.failed} failed</span>
                      )}
                    </span>
                  )}
                  <span className="mono mt-1 block text-micro text-ink-3">
                    {stage.entered.toLocaleString()} entered
                    {rate !== null && !isTerminal && <> · {pct(rate)} advanced</>}
                  </span>
                  {delta && delta.tone !== "steady" && (
                    <span
                      className={cx(
                        "mono mt-1.5 inline-block rounded-chip px-1.5 py-0.5 text-micro font-semibold",
                        DELTA_TONE[delta.tone],
                      )}
                    >
                      {delta.tone === "worse" ? "▲" : "▼"}{" "}
                      {delta.failedDelta !== 0
                        ? `${delta.failedDelta > 0 ? "+" : ""}${delta.failedDelta} failed`
                        : `${delta.inFlightDelta > 0 ? "+" : ""}${delta.inFlightDelta} waiting`}
                    </span>
                  )}
                </td>
              );
            })}
          </tr>
        </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-rule-enamel bg-midnight-3 px-4 py-3 text-xs text-ink-2">
        <span className="mono">
          {summary.trackedRefs.toLocaleString()} payments tracked
        </span>
        <span className="text-ink-4" aria-hidden>
          ·
        </span>
        <span className="mono">
          {waitingTotal.toLocaleString()} waiting in the pipeline
        </span>
        {summary.failedRefs > 0 && (
          <>
            <span className="text-ink-4" aria-hidden>
              ·
            </span>
            <span className="mono text-text-suspended">
              {summary.failedRefs.toLocaleString()} failed
            </span>
          </>
        )}
        {notReporting > 0 && (
          <>
            <span className="text-ink-4" aria-hidden>
              ·
            </span>
            <span className="mono text-text-delayed">
              {notReporting} of {stages.length} stages not reporting
            </span>
          </>
        )}
      </div>
    </div>
  );
}
