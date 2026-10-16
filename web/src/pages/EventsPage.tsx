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
import type { Connector, LifecycleEvent } from "@/types/domain";
import { BTN, Card, EmptyState, INPUT, PageHeader, SearchBox } from "@/components/ui";
import { EventStream } from "@/components/Tables";
import { FilterChips, toggleInSet } from "@/components/FilterChips";
import { IconChevronRight } from "@/components/icons";
import { STAGE_EVENT_TYPES, STAGE_LABEL, isFlowStage } from "@/utils/flow";
import {
  ALL_TIME,
  FAMILY_LABEL,
  FAMILY_ORDER,
  NO_FILTERS,
  WINDOW_PRESETS,
  channelsPresent,
  connectionRefs,
  familyCounts,
  filterEvents,
  isUnfiltered,
} from "@/utils/eventFilters";
import type { EventFamily, EventFilters, WindowPreset } from "@/utils/eventFilters";
import { hashQueryParam, navigate } from "@/router";

export function EventsPage({
  events,
  connectors,
  mode,
  stage,
}: {
  events: LifecycleEvent[];
  /** Used only to name a connection filter by its label rather than its ref. */
  connectors: Connector[];
  mode: "demo" | "live";
  /** Stage filter from the route (events/:stage). Null shows everything. */
  stage?: string | null;
}) {
  const [query, setQuery] = useState("");

  const stageFilter = isFlowStage(stage) ? stage : null;
  const stageTypes = stageFilter ? STAGE_EVENT_TYPES[stageFilter] : null;

  /*
    The INCIDENT filter, carried in the hash's query string (`#/events?…`) so the
    link from an incident's detail page is shareable and survives a reload — the
    same reason the invite token rides there.

    It carries the MATCHED EVENT IDS, not the incident's title. The title cannot
    select events: a finding's title ("QuickBooks Online is not answering") is
    operator-facing prose, while the event's detail is a different sentence
    ("QuickBooks Online: Upstream request to … failed"). Matching one against the
    other matches nothing, and matching on keywords instead would be a second,
    subtly different implementation of a question `relatedEventsFor` has already
    answered on the page the operator came from.

    Two parameters, because they answer two different questions: `ids` decides
    what is listed, `incident` is the human name for the banner. Both are guarded
    — a hand-edited or truncated value must not throw the console over; it just
    means no filter.

    READ ON EVERY RENDER, NOT MEMOISED. Both values come from the location hash,
    and this page STAYS MOUNTED when the hash changes — clearing the filter
    navigates within the same route. A `useMemo` with no dependencies latched the
    values on first render and the clear button appeared to do nothing at all.
    The stage filter does not share the fault because its value arrives as a prop
    from the router, so the render that follows the navigation recomputes it.
  */
  const incidentIds = (() => {
    const raw = hashQueryParam("ids");
    if (!raw) return null;
    const ids = raw.split(",").filter(Boolean);
    return ids.length > 0 ? new Set(ids) : null;
  })();

  const incidentTitle = (() => {
    const key = hashQueryParam("incident");
    if (!key) return null;
    try {
      return atob(key);
    } catch {
      return null;
    }
  })();

  // The stage filter composes with the incident filter rather than replacing it:
  // narrowing to a stage and then to an incident should show their intersection.
  const inIncident = incidentIds ? events.filter((e) => incidentIds.has(e.id)) : events;
  const inStage = stageTypes ? inIncident.filter((e) => stageTypes.includes(e.type)) : inIncident;

  /*
    THE OPERATOR'S OWN FILTERS, layered ON TOP of the two that arrive from the
    URL. Order is incident → stage → these → search: each narrows the previous.
  */
  const [filters, setFilters] = useState<EventFilters>(NO_FILTERS);
  const [showCustomRange, setShowCustomRange] = useState(false);

  const windowed = filterEvents(inStage, filters);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? windowed.filter(
        (e) =>
          e.channel.toLowerCase().includes(q) ||
          e.detail.toLowerCase().includes(q) ||
          e.ref.toLowerCase().includes(q) ||
          e.type.toLowerCase().includes(q),
      )
    : windowed;

  const familyTotals = familyCounts(inStage);
  const channelOptions = channelsPresent(inStage);
  const refOptions = connectionRefs(inStage);
  const active = !isUnfiltered(filters);

  /** Label a connection ref with its connector name where one is known. */
  const refLabel = (ref: string) =>
    connectors.find((c) => c.id === ref)?.label ?? ref;

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

      {incidentIds && (
        <div className="flex flex-wrap items-center gap-3 rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2">
          <span className="text-micro uppercase tracking-label text-ink-3">Filtered to incident</span>
          <span className="inline-flex items-center gap-1.5 rounded-chip bg-primary-soft py-1 pr-1 pl-2 text-sm font-semibold text-primary-ink">
            {incidentTitle ?? "this incident"}
            <button
              type="button"
              className="grid size-[18px] cursor-pointer place-items-center rounded-[4px] border-0 bg-transparent p-0 text-lg leading-none text-inherit hover:bg-[rgb(0_0_0/0.28)]"
              aria-label="Clear the incident filter"
              onClick={() => navigate("events")}
            >
              ×
            </button>
          </span>
          <span className="text-sm text-ink-3">
            Showing the {filtered.length} events recorded while this incident was reported,
            including its recovery.
          </span>
        </div>
      )}

      {/*
        THE FILTER TOOLBAR.

        Four axes, each multi-select, each independent — an untouched axis means
        "every value", so the row reads as a set of openings rather than a set of
        things already applied. Selections within an axis OR together; the axes
        AND with each other. "Declined or failed, on the accounting channel, in
        the last hour" is the shape an operator actually asks for.

        Every chip shows its count from `inStage`, so the numbers describe the
        URL filters in force and change with them rather than reporting totals
        that ignore the context.
      */}
      <div className="flex flex-col gap-2">
        <FilterChips<EventFamily>
          label="Filter by event type"
          options={FAMILY_ORDER.map((family) => ({
            id: family,
            label: FAMILY_LABEL[family],
            count: familyTotals[family],
          }))}
          selected={filters.families}
          onToggle={(id) =>
            setFilters((prev) => ({ ...prev, families: toggleInSet(prev.families, id) }))
          }
        />

        <FilterChips<string>
          label="Filter by channel"
          options={channelOptions.map((channel) => ({
            id: channel,
            label: channel,
            count: inStage.filter((e) => e.channel === channel).length,
          }))}
          selected={filters.channels}
          onToggle={(id) =>
            setFilters((prev) => ({ ...prev, channels: toggleInSet(prev.channels, id) }))
          }
        />

        {/*
          Connections appear only when there is more than one to choose between.
          A single-route deployment — which is the normal case — would otherwise
          spend a whole row on one chip that is either redundant or, worse,
          implies the others are hidden somewhere.
        */}
        {refOptions.length > 1 && (
          <FilterChips<string>
            label="Filter by connection"
            options={refOptions.map((ref) => ({
              id: ref,
              label: refLabel(ref),
              count: inStage.filter((e) => e.ref === ref).length,
            }))}
            selected={filters.connections}
            onToggle={(id) =>
              setFilters((prev) => ({ ...prev, connections: toggleInSet(prev.connections, id) }))
            }
          />
        )}

        <FilterChips<WindowPreset | "custom">
          label="Filter by time window"
          options={[
            ...WINDOW_PRESETS.map((preset) => ({
              id: preset.id,
              label: preset.label,
            })),
            { id: "custom" as const, label: "Custom…" },
          ]}
          selected={
            filters.window.kind === "custom"
              ? new Set(["custom" as const])
              : new Set([filters.window.preset])
          }
          onToggle={(id) => {
            if (id === "custom") {
              /*
                Custom opens the two inputs rather than applying a range
                immediately. A custom chip that filters to nothing the moment it
                is pressed would blank the list before the operator has said
                which range they mean.
              */
              setShowCustomRange(true);
              return;
            }
            setShowCustomRange(false);
            setFilters((prev) => ({ ...prev, window: { kind: "preset", preset: id } }));
          }}
          trailing={
            active ? (
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-sm font-semibold text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
                onClick={() => {
                  /*
                    Clears ONLY these filters. The stage and incident filters came
                    from the URL, and silently dropping them here would undo a
                    navigation the operator made — from a control that never
                    claimed to touch it.
                  */
                  setFilters(NO_FILTERS);
                  setShowCustomRange(false);
                }}
              >
                Clear filters
              </button>
            ) : undefined
          }
        />

        {showCustomRange && filters.window.kind !== "custom" && (
          <div className="flex flex-wrap items-end gap-3 rounded-panel border border-rule-enamel bg-midnight-2 px-3 py-2">
            <label className="flex flex-col gap-1">
              <span className="mono text-micro uppercase tracking-label text-ink-3">From</span>
              <input
                type="datetime-local"
                className={INPUT}
                onChange={(event) => {
                  const from = event.target.value;
                  setFilters((prev) => ({
                    ...prev,
                    window: { kind: "custom", from, to: prev.window.kind === "custom" ? prev.window.to : "" },
                  }));
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="mono text-micro uppercase tracking-label text-ink-3">To</span>
              <input
                type="datetime-local"
                className={INPUT}
                onChange={(event) => {
                  const to = event.target.value;
                  setFilters((prev) => ({
                    ...prev,
                    window: { kind: "custom", from: prev.window.kind === "custom" ? prev.window.from : "", to },
                  }));
                }}
              />
            </label>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setShowCustomRange(false);
                setFilters((prev) => ({ ...prev, window: ALL_TIME }));
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

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
            {/*
              "in the current window" is stated whenever anything is narrowing
              the list. The server sends the newest 500 events and no more, so a
              filtered count is a count of what ARRIVED — a "7d" filter over a
              window holding three days of traffic is not a quiet week, it is a
              short window, and the wording has to leave room for that.
            */}
            {filtered.length} {active || stageFilter ? `of ${inStage.length}` : ""} events
            {active ? " in the current window" : ""} · {mode === "demo" ? "synthetic" : "live"}
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
                : active
                  ? "No events match these filters"
                  : "No events match this search"
            }
            lead={
              inStage.length === 0
                ? stageFilter
                  ? `Nothing has reached the ${STAGE_LABEL[stageFilter]} stage within the current event window. That may mean quiet traffic, not a healthy stage — the spine reports the same state as "not reporting".`
                  : "No operational events have been recorded yet. Activity will appear here as payments and synchronisations run."
                : active
                  ? `The filters are narrowing ${inStage.length} events to none. The window holds the newest 500 events only, so a narrow time range can legitimately come back empty.`
                  : "Try a different connector, reference, or event type."
            }
            action={
              active ? (
                <button
                  type="button"
                  className={BTN}
                  onClick={() => {
                    setFilters(NO_FILTERS);
                    setShowCustomRange(false);
                  }}
                >
                  Clear filters
                </button>
              ) : stageFilter ? (
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
