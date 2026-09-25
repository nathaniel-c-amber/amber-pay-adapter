/* Overview — the flow ledger.
 *
 * This page used to be a resource-health console: four KPI tiles, a connection
 * table, and a topology diagram as the hero. It answered "are my integrations
 * up?" — a question the operator can already answer from the sidebar — and put
 * the topology, which never changes, in the top third of the screen.
 *
 * It now answers the question that actually needs an operator:
 *
 *   1. Is payment flow healthy, and where is it stuck?   (verdict + spine)
 *   2. What changed since the last look?                 (deltas)
 *   3. What needs me right now?                          (attention queue)
 *   4. Can I trust these numbers at all?                 (service window)
 *   5. What just happened?                               (activity, annotated)
 *
 * The spine is the hero because "6 payments have been sitting at Ingested for
 * 47 minutes" is the sentence an operator acts on. The topology stays where it
 * is useful — /connections — rather than being repeated here.
 *
 * No amounts, no currency, no customer PII, no ledger values (FR-2.3 / FR-5.2).
 * Stages, counts, ages, and durations only. */

import type { ApiServiceStatus } from "@/types/api";
import type { MappedMetrics } from "@/services/map.service";
import type { EventType, Failure } from "@/types/domain";
import type { FlowHealth, FlowComparison } from "@/utils/flow";
import {
  FLOW_HEALTH_LABEL,
  STAGE_LABEL,
  aggregateFlowHealth,
  formatAge,
  stagesNotReporting,
} from "@/utils/flow";
import type { Health } from "@/utils/vocabulary";
import { formatDate, formatDateTime, formatDateTimeSeconds, formatTimeOfDay } from "@/utils/datetime";
import { BTN, Card, cx, EmptyState, FindingCard, HealthBadge, LINK_BTN, StaleNotice } from "@/components/ui";
import { FlowSpine } from "@/components/FlowSpine";
import { ServiceWindow } from "@/components/ServiceWindow";
import { IconChevronRight, IconStageIngested } from "@/components/icons";
import { navigate } from "@/router";
import { T_ANCHOR } from "@/tour/anchors";

const STALE_MS = 2 * 60_000;

function secondsAgo(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function ageLabel(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

/** The console's flow vocabulary mapped onto the shared health vocabulary, so
 *  one badge component and one set of words covers both models. */
const HEALTH_OF_FLOW: Record<FlowHealth, Health> = {
  healthy: "healthy",
  degraded: "degraded",
  failed: "failed",
  blind: "unknown",
};

/** How each lifecycle event type reads as a position in the flow. */
const EVENT_FLOW_NOTE: Record<EventType, { text: string; tone: "stage" | "bad" | "muted" }> = {
  initiated: { text: "Initiated", tone: "stage" },
  collected: { text: "Collected", tone: "stage" },
  "webhook-received": { text: "Ingested", tone: "stage" },
  "record-updated": { text: "Posted", tone: "stage" },
  "payment-declined": { text: "Halted", tone: "bad" },
  "payment-failed": { text: "Halted", tone: "bad" },
  "sync-change": { text: "Cadence", tone: "muted" },
  // A refund is a delivered outcome, not a fault: it reads as muted so it is
  // not mistaken for the Halted events it sits next to.
  "payment-refunded": { text: "Reversed", tone: "muted" },
  // The accounting link itself. "Link" is the word the rest of the console uses
  // for an adaptor connection, so these rows cannot be read as payment faults.
  "adaptor-unreachable": { text: "Link down", tone: "bad" },
  "adaptor-auth-failed": { text: "Link rejected", tone: "bad" },
  "adaptor-restored": { text: "Link restored", tone: "muted" },
};

/** Tone → the "changed" detail's ink. `steady` rows never render (the list
 *  filters them out), but keeping the key makes the lookup total. */
const CHANGED_TONE: Record<"improved" | "steady" | "worse", string> = {
  worse: "text-text-suspended",
  improved: "text-line-green",
  steady: "",
};

/** The activity note reads as a stage position, a halt, or cadence noise. */
const FLOW_NOTE: Record<"stage" | "bad" | "muted", string> = {
  stage: "text-primary-ink bg-primary-soft",
  bad: "text-text-suspended bg-state-tint-suspended",
  muted: "text-ink-3 bg-midnight-3",
};

type EventNote = { text: string; tone: "stage" | "bad" | "muted" };

/**
 * Fallback for a lifecycle event type this build does not know.
 *
 * NOT hypothetical: the API and the console ship as separate images, and a
 * backend that starts recording a NEW event type (the adaptor lifecycle events,
 * for instance) will feed an older cached bundle. Without this the lookup below
 * returned `undefined` and reading `.tone` threw, taking the whole Overview
 * down — a deployment-order skew is not a reason to blank the console.
 */
const UNKNOWN_EVENT_NOTE: EventNote = { text: "Event", tone: "muted" };

function flowNoteFor(type: string): EventNote {
  return (EVENT_FLOW_NOTE as Record<string, EventNote | undefined>)[type] ?? UNKNOWN_EVENT_NOTE;
}

export function OverviewPage({
  data,
  findings,
  onAck,
  ackError,
  now,
  comparison,
  service,
  serviceUnavailable,
}: {
  data: MappedMetrics;
  /**
   * The open findings AFTER acknowledgement filtering, owned by the shell.
   * This page must never read `data.failures` directly: the shell's bell and
   * sidebar count the filtered list, so rendering the unfiltered one made
   * Acknowledge look broken here while the chrome silently changed.
   */
  findings: Failure[];
  onAck: (id: string) => void;
  ackError: string | null;
  /** A ticking clock owned by the shell, so ages and uptime stay live. */
  now: Date;
  comparison: FlowComparison | null;
  service: ApiServiceStatus | null;
  serviceUnavailable: boolean;
}) {
  const { events, generatedAt, stages } = data;

  const staleSec = secondsAgo(generatedAt);
  const isStale = staleSec > STALE_MS / 1000;

  const attention: Failure[] = [...findings].sort(
    (a, b) => (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1),
  );

  // The verdict, the badge, and the action all derive from the same value, so
  // a "Failed" badge can never sit beside a headline describing something else.
  const flowHealth: FlowHealth = stages ? aggregateFlowHealth(stages.stages) : "blind";
  const blindStages = stages ? stagesNotReporting(stages.stages) : 0;

  // The single most actionable number on the page: how long the oldest unpaid-
  // through item has been waiting, and where.
  const oldest = stages
    ? stages.stages
        .filter((s) => s.stage !== "posted" && s.inFlight > 0 && s.oldestInFlightAt)
        .reduce<{ stage: string; at: string } | null>((acc, s) => {
          const at = s.oldestInFlightAt as string;
          if (!acc || new Date(at) < new Date(acc.at)) return { stage: s.stage, at };
          return acc;
        }, null)
    : null;

  const stuckStages = stages
    ? stages.stages.filter((s) => !s.notReporting && s.state !== "healthy")
    : [];

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      {/* 1 — the verdict */}
      <section
        className="flex flex-wrap items-start justify-between gap-6 rounded-panel border border-rule-enamel bg-midnight-2 px-6 py-5 shadow-panel data-[health=failed]:border-[rgb(248_113_113/0.35)] data-[health=degraded]:border-[rgb(251_191_36/0.3)] data-[health=unknown]:border-rule-enamel max-sm:flex-col"
        data-health={HEALTH_OF_FLOW[flowHealth]}
        aria-label="Flow health"
      >
        <div className="min-w-0 grow shrink basis-auto">
          <div className="flex flex-wrap items-center gap-3">
            <HealthBadge health={HEALTH_OF_FLOW[flowHealth]} live={flowHealth === "healthy"} />
            {/*
              The page's real `h1`. It was an `h2`, and the only `h1` came from
              the shell's chrome title — which is display:none at >=720px — so
              the console's DEFAULT route had no level-one heading at all on
              desktop, and heading navigation reported nothing to land on
              (SC 1.3.1 / 2.4.6). The verdict is already the largest thing on
              the page, so it is also the honest choice of heading.
            */}
            <h1 className="text-3xl text-ink-1">{verdictTitle(flowHealth, stuckStages)}</h1>
          </div>
          <p className="mt-2 max-w-[68ch] text-md text-ink-2">{verdictLead(flowHealth, stuckStages, blindStages)}</p>
        </div>
        <div className="flex flex-none flex-col items-end gap-2 max-sm:items-start">
          <button
            type="button"
            className={BTN}
            onClick={() => navigate(findings.length > 0 ? "findings" : "events")}
          >
            {findings.length > 0
              ? `View ${findings.length} open finding${findings.length === 1 ? "" : "s"}`
              : "View event log"}
            <IconChevronRight />
          </button>
        </div>

        {oldest && (
          <div className="mt-4 flex shrink-0 grow basis-full items-center gap-2 border-t border-rule-enamel-soft pt-3 text-sm text-ink-2 [&_b]:text-ink-1">
            <span className="inline-grid size-5.5 flex-none place-items-center rounded-chip bg-midnight-3 text-ink-2" aria-hidden>
              <IconStageIngested size={14} />
            </span>
            <span>
              Oldest payment still moving: <b>{formatAge(oldest.at, now)}</b> at{" "}
              {STAGE_LABEL[oldest.stage as keyof typeof STAGE_LABEL]}
            </span>
          </div>
        )}
      </section>

      {/* Freshness is reported BELOW the health verdict, never above it: an
          amber "data may be stale" bar must not outrank a red failure. */}
      {isStale && <StaleNotice age={ageLabel(staleSec)} />}

      {/* 2 — the flow spine (the hero) */}
      {stages ? (
        /*
          The tour's `flow` anchor. It sits on the branch that actually renders
          the ledger, so when the server returns no stage aggregate the anchor is
          simply ABSENT and the step is skipped — rather than spotlighting an
          error state and describing it as the payment pipeline.
        */
        <section
          className="flex flex-col gap-3"
          aria-label="Payment flow"
          data-tour={T_ANCHOR.flowSpine}
        >
          <header className="flex flex-wrap items-baseline justify-between gap-4">
            <h2 className="text-xl text-ink-1">Payment flow</h2>
            <span className="mono text-xs uppercase tracking-label text-ink-3">
              {FLOW_HEALTH_LABEL[flowHealth]}
              {stages.mayBeTruncated && " · sampled"}
              {" · "}
              as of {formatDateTimeSeconds(generatedAt)}
            </span>
          </header>
          <FlowSpine
            summary={stages}
            comparison={comparison}
            now={now}
            onDrill={(stage) => navigate("events", stage)}
            notReporting={blindStages}
          />
        </section>
      ) : (
        <section className="flex flex-col gap-3" aria-label="Payment flow">
          <EmptyState
            title="Flow data unavailable"
            lead="This server build does not return the stage aggregate, so the console cannot say where payments are sitting. Connection health is still reported on the Connections page."
            action={
              <button type="button" className={BTN} onClick={() => navigate("connections")}>
                View connections
                <IconChevronRight />
              </button>
            }
          />
        </section>
      )}

      {/* An acknowledge failure must survive the queue emptying, so it is
          reported at page level rather than inside the finding stack. */}
      {ackError && (
        <div className="mt-3 text-sm text-text-suspended" role="alert">
          {ackError} — the finding is still open.
        </div>
      )}

      <div className="grid items-start gap-4 grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] max-2xl:grid-cols-[minmax(0,1fr)]">
        {/* 3 — attention queue */}
        <Card
          title="Attention required"
          meta={findings.length > 0 ? `${findings.length} open` : undefined}
          className="ov-attention"
        >
          {attention.length === 0 ? (
            <EmptyState
              title="Nothing needs attention"
              lead="No open findings. Critical failures and warnings appear here the moment they are logged."
              action={
                <button type="button" className={BTN} onClick={() => navigate("events")}>
                  View event log
                  <IconChevronRight />
                </button>
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              {attention.slice(0, 3).map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  onAck={onAck}
                  onOpen={(id) => navigate("findings", id)}
                />
              ))}
              {/* Always offered, not only past three: at exactly three the
                  card previously had no escape at all. */}
              <div className="mt-3 border-t border-rule-enamel-soft pt-3">
                <button type="button" className={cx(LINK_BTN, "inline-flex items-center gap-1.5")} onClick={() => navigate("findings")}>
                  View all findings
                  <IconChevronRight />
                </button>
              </div>
            </div>
          )}
        </Card>

        {/* 4 — what changed since the last look. A single poll says where
            things are; only a comparison says whether it is getting worse. */}
        <Card
          title="What changed"
          meta={comparison ? `since ${formatDateTime(comparison.since)}` : undefined}
          className="ov-changed"
        >
          {!comparison ? (
            <p className="mb-0 max-w-[62ch] text-md text-ink-2">
              Baseline captured at {formatDateTimeSeconds(generatedAt)}. Deltas appear here as soon as the console
              has a second reading to compare against — no change is not the same as no news.
            </p>
          ) : comparison.steady ? (
            <p className="mb-0 max-w-[62ch] text-md text-ink-2">
              No movement since {formatDateTime(comparison.since)} — dwell, queue depth, and failures are all
              where they were.
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {comparison.deltas
                .filter((d) => d.tone !== "steady")
                .map((d) => (
                  <li key={d.stage} className="flex items-baseline justify-between gap-4 border-b border-rule-enamel-soft px-1 py-2 last:border-b-0">
                    <span className="text-md text-ink-1">{d.label}</span>
                    <span className={cx("mono text-sm font-semibold", CHANGED_TONE[d.tone])}>
                      {d.failedDelta !== 0 && (
                        <>
                          {d.failedDelta > 0 ? "+" : ""}
                          {d.failedDelta} failed
                        </>
                      )}
                      {d.failedDelta !== 0 && d.inFlightDelta !== 0 && " · "}
                      {d.inFlightDelta !== 0 && (
                        <>
                          {d.inFlightDelta > 0 ? "+" : ""}
                          {d.inFlightDelta} waiting
                        </>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          <div className="mt-3 border-t border-rule-enamel-soft pt-3">
            <button
              type="button"
              className={cx(LINK_BTN, "inline-flex items-center gap-1.5")}
              onClick={() => navigate("synchronization")}
            >
              View synchronisation
              <IconChevronRight />
            </button>
          </div>
        </Card>
      </div>

      {/* 5 — the window into the backend process itself. Without this, "all
          healthy" and "the service stopped answering" look identical. */}
      <ServiceWindow service={service} now={now} unavailable={serviceUnavailable} />

      {/* 6 — recent activity, annotated with the stage each event moved a
          payment into, so the stream reads as flow rather than a log dump. */}
      <Card
        title="Recent activity"
        meta="operational events only · no financial or customer data"
        className="ov-events"
        actions={
          <button type="button" className={LINK_BTN} onClick={() => navigate("events")}>
            Full event log
            <IconChevronRight />
          </button>
        }
      >
        {events.length === 0 ? (
          <EmptyState
            title="No recent activity"
            lead="No operational events have been recorded yet. Payments, webhooks, and scheduled pulls will appear here as they run."
          />
        ) : (
          <ol className="m-0 list-none p-0">
            {events.slice(0, 6).map((e) => {
              const note = flowNoteFor(e.type);
              return (
                <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-rule-enamel-soft px-1 py-3 last:border-b-0 max-md:grid-cols-[auto_minmax(0,1fr)] max-md:gap-y-1.5" key={e.id}>
                  {/* Date over time, as in the event log — the shared formatter
                      keeps the two lines together so neither is a bare clock. */}
                  <span className="mono flex flex-col text-xs text-ink-3">
                    <span className="whitespace-nowrap">{formatDate(e.at)}</span>
                    <span className="whitespace-nowrap">{formatTimeOfDay(e.at)}</span>
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    {/*
                      `min-w-0` AND `wrap-anywhere`, and both are needed. The
                      track is `minmax(0, 1fr)`, but the inner spans are flex
                      items of a column, and a URL in a detail has no break
                      opportunity — so the column took its full min-content width
                      and pushed the badge off the right edge of the card.
                    */}
                    <span className="text-md text-ink-1 wrap-anywhere">{e.detail}</span>
                    <span className="mono text-micro text-ink-3 wrap-anywhere">
                      {e.channel} · {e.ref}
                    </span>
                  </span>
                  <span className={cx("whitespace-nowrap rounded-chip px-2 py-0.5 text-micro font-semibold uppercase tracking-label max-md:col-[2/-1] max-md:justify-self-start", FLOW_NOTE[note.tone])}>
                    {note.tone === "stage" && <span aria-hidden>→ </span>}
                    {note.text}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ copy */

function verdictTitle(
  health: FlowHealth,
  stuck: { stage: string; state: string }[],
): string {
  if (health === "blind") {
    return "Flow status unavailable";
  }
  if (health === "failed") {
    const failed = stuck.filter((s) => s.state === "failed");
    const where = failed.map((s) => STAGE_LABEL[s.stage as keyof typeof STAGE_LABEL]);
    return `Payments are stuck at ${where.join(" and ") || "a stage"}`;
  }
  if (health === "degraded") {
    const names = stuck.map((s) => STAGE_LABEL[s.stage as keyof typeof STAGE_LABEL]);
    return `Flow is slower than target at ${names.join(" and ") || "a stage"}`;
  }
  return "Payment flow is healthy";
}

function verdictLead(
  health: FlowHealth,
  stuck: { stage: string; state: string; inFlight: number }[],
  blindStages: number,
): string {
  if (health === "blind") {
    return "The console has no stage readings, so it cannot say where payments are. This is silence, not health — check the backend service window below.";
  }
  if (health === "failed") {
    const waiting = stuck.reduce((n, s) => n + s.inFlight, 0);
    return `${waiting} payment${waiting === 1 ? "" : "s"} are waiting and not advancing. Nothing is lost — items queue and resume — but they will not post until the stage recovers.`;
  }
  if (health === "degraded") {
    return `Payments are still moving and nothing is queueing, but at least one stage is outside its target time.${blindStages > 0 ? ` ${blindStages} stage${blindStages === 1 ? " is" : "s are"} not reporting at all.` : ""}`;
  }
  return `Every stage is inside its target time and nothing is waiting.${blindStages > 0 ? ` ${blindStages} stage${blindStages === 1 ? " is" : "s are"} not reporting — those are silent, not proven healthy.` : ""}`;
}
