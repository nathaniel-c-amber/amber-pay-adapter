/* Events — the full operational lifecycle log.
 *
 * Operational data only: event type, connector, timestamp, reference hash,
 * status, and duration. No amounts, no PII, no ledger values (FR-2.3/FR-5.2).
 *
 * This page is also the drill-through target for the flow spine: arriving with
 * a stage (events/ingested) filters the log to the events that stage is derived
 * from, and says so in a clearable chip, so the operator can see what the spine
 * counted instead of being dropped into an unfiltered stream. */

import { useState } from "react";
import type { LifecycleEvent } from "@/types/domain";
import { BTN, Card, EmptyState, PageHeader, SearchBox } from "@/components/ui";
import { EventStream } from "@/components/Tables";
import { IconChevronRight } from "@/components/icons";
import { STAGE_EVENT_TYPES, STAGE_LABEL, isFlowStage } from "@/utils/flow";
import { navigate } from "@/router";

export function EventsPage({
  events,
  mode,
  stage,
}: {
  events: LifecycleEvent[];
  mode: "demo" | "live";
  /** Stage filter from the route (events/:stage). Null shows everything. */
  stage?: string | null;
}) {
  const [query, setQuery] = useState("");

  const stageFilter = isFlowStage(stage) ? stage : null;
  const stageTypes = stageFilter ? STAGE_EVENT_TYPES[stageFilter] : null;

  // Search is scoped to the active stage filter, not the whole log: filtering
  // to "Ingested" and then searching must not silently surface collected or
  // posted events that happen to match the text.
  const inStage = stageTypes ? events.filter((e) => stageTypes.includes(e.type)) : events;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? inStage.filter(
        (e) =>
          e.channel.toLowerCase().includes(q) ||
          e.detail.toLowerCase().includes(q) ||
          e.ref.toLowerCase().includes(q) ||
          e.type.toLowerCase().includes(q),
      )
    : inStage;

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="Event log"
        lead="The complete operational lifecycle stream. Reference hashes and statuses only — the console never stores or shows financial or customer data."
        actions={
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search type, connector, ref"
            label="Search events"
          />
        }
      />

      {stageFilter && (
        <div className="flex flex-wrap items-center gap-3 rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2">
          <span className="text-micro uppercase tracking-label text-ink-3">Filtered to stage</span>
          <span className="inline-flex items-center gap-1.5 rounded-chip bg-primary-soft py-1 pr-1 pl-2 text-sm font-semibold text-primary-ink">
            {STAGE_LABEL[stageFilter]}
            <button
              type="button"
              className="grid size-[18px] cursor-pointer place-items-center rounded-[4px] border-0 bg-transparent p-0 text-lg leading-none text-inherit hover:bg-[rgb(0_0_0/0.28)]"
              aria-label={`Clear the ${STAGE_LABEL[stageFilter]} stage filter`}
              onClick={() => navigate("events")}
            >
              ×
            </button>
          </span>
          <span className="text-sm text-ink-3">
            Showing the {stageTypes?.join(", ")} events the spine's {STAGE_LABEL[stageFilter]} column
            is computed from.
          </span>
        </div>
      )}

      <Card
        title={stageFilter ? `${STAGE_LABEL[stageFilter]} events` : "Lifecycle events"}
        meta={
          <span className="mono">
            {filtered.length} {stageFilter ? `of ${inStage.length}` : ""} events ·{" "}
            {mode === "demo" ? "synthetic" : "live"}
          </span>
        }
        className="ev-table"
      >
        {filtered.length === 0 ? (
          <EmptyState
            title={
              inStage.length === 0
                ? stageFilter
                  ? `No ${STAGE_LABEL[stageFilter].toLowerCase()} events in this window`
                  : "No recent events"
                : "No events match this search"
            }
            lead={
              inStage.length === 0
                ? stageFilter
                  ? `Nothing has reached the ${STAGE_LABEL[stageFilter]} stage within the current event window. That may mean quiet traffic, not a healthy stage — the spine reports the same state as "not reporting".`
                  : "No operational events have been recorded yet. Activity will appear here as payments and synchronisations run."
                : "Try a different connector, reference, or event type."
            }
            action={
              stageFilter ? (
                <button type="button" className={BTN} onClick={() => navigate("events")}>
                  Show all events
                  <IconChevronRight />
                </button>
              ) : undefined
            }
          />
        ) : (
          <EventStream events={filtered} />
        )}
      </Card>
    </div>
  );
}
