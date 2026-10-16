/* Findings â€” the attention queue, plus the incident detail view.
 *
 * A finding is the operator-facing record of something that needs action.
 * It follows the flow: Finding â†’ incident detail â†’ related events â†’
 * connector, so no card is a dead end. */

import { useMemo, useState } from "react";
import type { Connector, Failure, LifecycleEvent, PolicyScope } from "@/types/domain";
import { HEALTH_OF } from "@/utils/vocabulary";
import { formatDateTime } from "@/utils/datetime";
import { BTN, BTN_OUTLINE, BTN_PRIMARY, Card, cx, EmptyState, FindingCard, HealthBadge, LINK_BTN, PageHeader, SearchBox, SeverityBadge } from "@/components/ui";
import { Can } from "@/components/Can";
import { Modal } from "@/components/Modal";
import { CollapsibleList } from "@/components/CollapsibleList";
import { FilterChips } from "@/components/FilterChips";
import { TabPanel, Tabs } from "@/components/Tabs";
import { EventStream } from "@/components/Tables";
import { IconCheck, IconChevronRight, IconPolicy } from "@/components/icons";
import { ABILITY } from "@/utils/permissions";
import { adaptorRefsForGroup, groupFindings, groupKey, openGroupIds, relatedEventsFor } from "@/utils/findings";
import type { FindingGroup } from "@/utils/findings";
import { navigate } from "@/router";

type Filter = "all" | "critical" | "attention";
type View = "open" | "acknowledged";


/** How an incident group is matched against the search box. */
function matches(group: FindingGroup, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    group.title.toLowerCase().includes(q) ||
    group.channel.toLowerCase().includes(q) ||
    // The id of any occurrence, so a reference quoted from an alert or a support
    // thread still finds the incident it belongs to.
    group.members.some((member) => member.id.toLowerCase().includes(q))
  );
}

/** "1 incident" / "3 incidents" â€” the noun agrees with the count. */
function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function FindingsPage({
  findings,
  connectors,
  onAck,
  onAckAll,
  ackBusy,
  ackError,
  activePolicy,
}: {
  /** Every finding the caller can see, acknowledged or not â€” the page owns the
   *  Open / Acknowledged split rather than being handed a pre-filtered list. */
  findings: Failure[];
  connectors: Connector[];
  /** Acknowledges one incident: every occurrence belonging to it. */
  onAck: (ids: string[]) => void;
  /** Acknowledges every open occurrence across every incident. */
  onAckAll: (ids: string[]) => void;
  /** True while an acknowledgement is in flight; disables the actions. */
  ackBusy: boolean;
  ackError: string | null;
  activePolicy: PolicyScope | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("open");
  /* The ids the confirmation is about, captured when the dialog opens, or null
     while it is closed. */
  const [confirming, setConfirming] = useState<{ ids: string[]; incidents: number } | null>(null);

  /*
    GROUP FIRST, THEN SPLIT. Every repeated failure is one incident that happens
    to have been reported many times, so grouping happens before any view is
    chosen â€” otherwise the open tab counted occurrences and the acknowledged tab
    counted incidents, and the two tabs' totals would not be comparable.
  */
  const groups = useMemo(() => groupFindings(findings), [findings]);

  const openGroups = useMemo(() => groups.filter((group) => group.open), [groups]);
  const acknowledgedGroups = useMemo(() => groups.filter((group) => !group.open), [groups]);

  const critical = openGroups.filter((g) => g.severity === "critical").length;
  const warning = openGroups.length - critical;

  /*
    FILTERED PER VIEW, NOT ONCE FOR THE ACTIVE VIEW.

    Both panels stay mounted (`TabPanel` keeps them so a background refresh
    updates both and the operator's scroll position survives a tab switch), so
    handing each the currently-visible list would render the OPEN incidents
    inside the hidden Acknowledged panel too. It is invisible while hidden and
    silently wrong the moment either panel is shown — and `hidden` content is
    still in the DOM for find-in-page and for assistive technology, so it is not
    as harmless as it looks.
  */
  const byView = useMemo(
    () => ({
      open: openGroups
        .filter((group) => (filter === "all" ? true : group.severity === filter))
        .filter((group) => matches(group, query)),
      acknowledged: acknowledgedGroups
        .filter((group) => (filter === "all" ? true : group.severity === filter))
        .filter((group) => matches(group, query)),
    }),
    [openGroups, acknowledgedGroups, filter, query],
  );

  const visible = view === "open" ? openGroups : acknowledgedGroups;

  /*
    The one line that answers "where are we", replacing two pill rows that
    restated the same number twice. Occurrences and incidents are both stated
    because they are the two numbers an operator actually reasons with: "is it
    one broken thing or many" and "how much noise is it making".
  */
  /*
    OPEN occurrences, not total occurrences in open groups. A partly-acknowledged
    incident still counts every occurrence it has, but only the unacknowledged
    ones are still being reported — and "17 occurrences" beside a queue of 3
    open incidents has to mean the same thing in both places, or the two numbers
    contradict each other on the same screen.
  */
  const openOccurrences = openGroups.reduce((sum, group) => sum + group.openCount, 0);
  const oldestOpen = openGroups.length
    ? openGroups.reduce((oldest, g) => (g.firstSeen < oldest ? g.firstSeen : oldest), openGroups[0]!.firstSeen)
    : null;

  const tabs = [
    { id: "open" as View, label: "Open", count: openGroups.length, hint: "Incidents awaiting an operator" },
    {
      id: "acknowledged" as View,
      label: "Acknowledged",
      count: acknowledgedGroups.length,
      hint: "Incidents already seen, with who saw them",
    },
  ];

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="Findings"
        lead="Everything that needs an operator's attention, grouped by the problem rather than the report. Acknowledging records that it has been seen; it stays in the log."
        actions={
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search findings"
            label="Search findings"
          />
        }
      />

      {/*
        THE STATUS LINE. This is the scan an operator does first â€” is anything
        broken, how much of it is there, and how long has it been so â€” and it is
        now a single sentence instead of four count badges that were showing
        duplicate totals. It sits above the tabs because it describes the queue,
        not the view currently selected within it.
      */}
      {openGroups.length > 0 ? (
        <p className="text-sm text-ink-2" role="status">
          <span className="text-ink-1">{openGroups.length}</span> open{" "}
          {plural(openGroups.length, "incident", "incidents")}
          {openOccurrences > openGroups.length && (
            <>
              {" · "}
              <span className="text-ink-1">{openOccurrences}</span> occurrences
            </>
          )}
          {oldestOpen && (
            <>
              {" · oldest "}
              {formatAge(oldestOpen)}
            </>
          )}
        </p>
      ) : null}

      {/* View switcher: which incidents am I looking at. */}
      <Tabs items={tabs} active={view} onChange={setView} label="Acknowledgement status" idPrefix="findings-view" />

      {/*
        The severity chips, inside the view rather than above it. They narrow the
        incidents in view, so they belong to the panel they narrow.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterChips
          label="Filter by severity"
          options={
            [
              { id: "all" as Filter, label: "All", count: visible.length },
              ...(view === "open"
                ? [
                    { id: "critical" as Filter, label: "Critical", count: critical },
                    { id: "attention" as Filter, label: "Warning", count: warning },
                  ]
                : []),
            ]
          }
          // Single-select on this page, so the active chip is the whole set.
          selected={new Set(filter ? [filter] : [])}
          onToggle={(id) => setFilter(id)}
        />

        {/*
          THE BULK ACTION, DEMOTED.

          It sat directly under the page heading in primary treatment, which made
          a maintenance gesture the loudest thing on a page full of criticals â€”
          ahead of the very things it acknowledges. It now sits with the filters,
          quiet, and counts INCIDENTS rather than occurrences: "Acknowledge all 3"
          is a claim about three problems, where the old "Acknowledge all 17" was
          a claim about seventeen and read as far more destructive than it was.

          It acts on OPEN occurrences only. Re-acknowledging a handled one would
          overwrite the operator recorded against it with whoever clicked last.
        */}
{/*
          THE BULK ACTION.

          It first sat directly under the page heading in primary treatment, which
          made a maintenance gesture the loudest thing on a page full of
          criticals — ahead of the very things it acknowledges. It was then
          demoted all the way to `BTN`, which over-corrected: against the small
          grey severity chips it read as another quiet filter rather than as the
          one action this toolbar offers.

          So it sits between the two. An amber OUTLINE at the far right of the
          row, past a divider: unmistakably an action, unmistakably not one of
          the cards. Full `BTN_PRIMARY` fill is still reserved for the
          acknowledgement an operator makes about ONE incident, which is the
          decision the console is actually asking for.
        */}
        {view === "open" && openGroups.length > 0 && (
          <Can ability={ABILITY.findingAck}>
            <span className="ml-auto flex items-center gap-3 border-l border-rule-enamel">
              <button
                type="button"
                className={BTN_OUTLINE}
                disabled={ackBusy}
                onClick={() =>
                  setConfirming({
                    ids: openGroupIds(openGroups),
                    incidents: openGroups.length,
                  })
                }
              >
                <IconCheck />
                {ackBusy
                  ? "Acknowledging…"
                  : `Acknowledge all ${openGroups.length} ${plural(openGroups.length, "incident", "incidents")}`}
              </button>
            </span>
          </Can>
        )}
      </div>

      {/*
        The policy banner is CONDITIONAL now. It used to render on every load for
        every operator, costing a full row to tell a capable one something they
        already knew â€” and the information that matters is the constraint, not
        the confirmation. A read-only scope changes what the operator can do, so
        it says so; a writable one has nothing to announce.
      */}
      {activePolicy?.readOnly && (
        <div className="flex items-center gap-2 rounded-panel bg-midnight-3 px-3 py-2 text-sm text-ink-2 [&_svg]:text-line-amber">
          <IconPolicy />
          Read-only scope ({activePolicy.label}) â€” findings can be inspected but not acknowledged.
        </div>
      )}

      {ackError && <div className="text-sm text-text-suspended" role="alert">{ackError}</div>}

      <TabPanel id="findings-view-open-panel" active={view === "open"}>
        <FindingsPanel
          groups={byView.open}
          view="open"
          allOpenGroups={openGroups}
          hasAnyFindings={findings.length > 0}
          connectors={connectors}
          onAck={onAck}
          ackBusy={ackBusy}
        />
      </TabPanel>

      <TabPanel id="findings-view-acknowledged-panel" active={view === "acknowledged"}>
        <FindingsPanel
          groups={byView.acknowledged}
          view="acknowledged"
          allOpenGroups={openGroups}
          hasAnyFindings={findings.length > 0}
          connectors={connectors}
          onAck={onAck}
          ackBusy={ackBusy}
        />
      </TabPanel>

      {/*
        Confirm before acknowledging everything.

        This is the one action in the console that spends the acknowledgement
        ledger in bulk on incidents that may never have been read â€” including
        criticals â€” and it cannot be undone from the console. It also attributes
        every occurrence to whoever confirms, which is a real assertion about
        another operator's queue, not a cosmetic label.

        The dialog states BOTH numbers and what they mean: incidents is what the
        operator is agreeing to look at later, occurrences is what is actually
        being written. Neither alone would let them predict the effect.
      */}
      {confirming && (
        <Modal
          title="Acknowledge every open incident?"
          eyebrow="Confirm"
          onClose={() => setConfirming(null)}
          description={`${confirming.incidents} open ${plural(confirming.incidents, "incident", "incidents")} across ${confirming.ids.length} occurrences will be recorded as seen, attributed to you.`}
          footer={
            <>
              <button type="button" className={BTN} onClick={() => setConfirming(null)} disabled={ackBusy}>
                Cancel
              </button>
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={ackBusy}
                onClick={() => {
                  const batch = confirming;
                  setConfirming(null);
                  onAckAll(batch.ids);
                }}
              >
                {ackBusy
                  ? "Acknowledgingâ€¦"
                  : `Acknowledge ${confirming.incidents} ${plural(confirming.incidents, "incident", "incidents")}`}
              </button>
            </>
          }
        >
          <p className="m-0 max-w-[62ch] text-md text-ink-2">
            Acknowledging records that an incident has been <strong>seen</strong>. It does not
            resolve it, and each occurrence stays in the log with your name against it.
          </p>
          <p className="mt-3 mb-0 max-w-[62ch] text-md text-ink-2">
            Anything below that has not actually been read will be marked as seen anyway, and
            cannot be un-acknowledged from here.
          </p>
        </Modal>
      )}
    </div>
  );
}

/**
 * One view's worth of incidents: the empty state, or the grouped cards.
 *
 * Split out so the Open and Acknowledged tabs cannot drift apart in their empty
 * copy â€” they were near-identical before and each had to be reasoned about
 * twice.
 */
function FindingsPanel({
  groups,
  view,
  allOpenGroups,
  hasAnyFindings,
  connectors,
  onAck,
  ackBusy,
}: {
  groups: FindingGroup[];
  view: View;
  allOpenGroups: FindingGroup[];
  hasAnyFindings: boolean;
  connectors: Connector[];
  onAck: (ids: string[]) => void;
  ackBusy: boolean;
}) {
  if (groups.length === 0) {
    if (view === "acknowledged") {
      return (
        <EmptyState
          title="Nothing acknowledged yet"
          lead="When an incident is acknowledged it stays here, attributed to whoever acknowledged it."
        />
      );
    }
    if (allOpenGroups.length === 0) {
      return (
        <EmptyState
          title={hasAnyFindings ? "Everything logged has been acknowledged" : "No open findings"}
          lead={
            hasAnyFindings
              ? "Switch to Acknowledged to see who has seen what."
              : "Every connection is healthy and the synchronisation loop is within SLA. New findings appear here the moment they are logged."
          }
        />
      );
    }
    return (
      <EmptyState
        title="No incidents match this filter"
        lead="Try a different severity, or clear the search term."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const conn = connectors.find((c) => c.label === group.channel);
        return (
          <div className="flex flex-col gap-2" key={group.key}>
            <FindingCard
              group={group}
              onAck={onAck}
              ackBusy={ackBusy}
              onOpen={(id) => navigate("findings", id)}
            />
            {conn && (
              <div className="flex flex-wrap items-center gap-3 px-4 pt-0 pb-1 text-xs text-ink-3">
                <span className="mono">Affected connection</span>
                <HealthBadge health={HEALTH_OF[conn.status]} />
                <button
                  type="button"
                  className={LINK_BTN}
                  onClick={() => navigate("connections", conn.id)}
                >
                  {conn.label}
                  <IconChevronRight />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** "4m", "3h", "2d" â€” how long an incident has been open, at a glance. */
function formatAge(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Incident detail: /findings/:id */
export function FindingDetailPage({
  finding,
  group,
  connectors,
  events,
  onAck,
  ackBusy,
  ackError,
}: {
  /** The occurrence the route names, when it is still in the window. */
  finding: Failure | undefined;
  /** The whole incident it belongs to — every occurrence, acknowledged or not. */
  group: FindingGroup | undefined;
  connectors: Connector[];
  events: LifecycleEvent[];
  onAck: (ids: string[]) => void;
  ackBusy: boolean;
  ackError: string | null;
}) {
  /*
    Declared BEFORE the not-found return below, and that is not stylistic.

    React matches hooks by call order, so a `useState` placed after a conditional
    return is skipped on the render that takes the early exit — and the next
    navigation back to a real incident throws "Rendered fewer hooks than
    expected". Every hook in this component has to sit above the guard.
  */
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  if (!finding || !group) {
    return (
      <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
        <PageHeader title="Finding not found" lead="This finding is not in the current data set." />
        <EmptyState
          title="No such finding"
          lead="It may have aged out of the current window, or the link may be stale."
          action={
            <button type="button" className={BTN} onClick={() => navigate("findings")}>
              Back
            </button>
          }
        />
      </div>
    );
  }

  const related = relatedEventsFor(group, events);
  /*
    THE CONNECTOR JOIN runs through the incident's events — `adaptorRefsForGroup`
    holds the reasoning, and the Connections page uses the same helper so the two
    directions cannot disagree about which incidents belong to a connector.
  */
  const adaptorRefs = adaptorRefsForGroup(group, events);
  const connector = connectors.find((c) => adaptorRefs.has(c.id));

  /*
    AT MOST FIVE EVENTS INLINE.

    An incident can report hundreds of occurrences, and listing every related
    event turned the detail page into the event log with a header — burying the
    occurrence list, which is what this page is for. Five of the most recent is
    enough to see how it is behaving now; the complete set is one click away
    through the link below, which carries the same selection rather than making
    the operator hunt for it.
  */
  const RECENT_EVENTS = 5;
  const recent = related.slice(-RECENT_EVENTS).reverse();
  const hiddenEventCount = related.length - recent.length;

  /*
    WHICH OCCURRENCES ARE LISTED.

    Default is OPEN ONLY, because this page is an attention queue: an operator
    arriving from an alert needs what is still outstanding, not a scroll past
    sixteen rows somebody already dealt with. But "17 occurrences" in the header
    with five rows on screen is a contradiction unless the rest are reachable, so
    acknowledged ones are one toggle away rather than gone.

    The two axes are kept separate on purpose. This chooses WHICH occurrences;
    the disclosure chooses HOW MANY rows. Folding them together would make
    "show more" and "show acknowledged" mean the same gesture, and an operator
    wanting the older open ones would have to reveal the acknowledged ones too.
  */
  // Newest first — the occurrence an operator most likely wants is the latest.
  const occurrences = [...group.members].sort((a, b) => b.since.localeCompare(a.since));
  const openIds = group.members.filter((m) => !m.acknowledgedAt).map((m) => m.id);
  const acknowledgedCount = occurrences.length - openIds.length;
  const listedOccurrences = showAcknowledged
    ? occurrences
    : occurrences.filter((occurrence) => !occurrence.acknowledgedAt);

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <button
        type="button"
        className={cx(BTN, "self-start")}
        onClick={() => navigate("findings")}
      >
        <IconChevronRight className="rotate-180" />
        Back
      </button>

      <PageHeader
        title={group.title}
        lead={`${group.channel} · reported ${occurrences.length} ${plural(occurrences.length, "time", "times")} between ${formatDateTime(group.firstSeen)} and ${formatDateTime(group.lastSeen)}`}
        actions={<SeverityBadge severity={group.severity} />}
      />

      <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-2xl:grid-cols-[minmax(0,1fr)]">
        <Card title="Operational impact" className="fd-impact">
          <p className="wrap-anywhere">{finding.detail}</p>
          <dl className="flex flex-col">
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Incident</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">
                {occurrences.length} {plural(occurrences.length, "occurrence", "occurrences")}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Severity</dt>
              <dd className="m-0 text-right text-md text-ink-1">
                <SeverityBadge severity={group.severity} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">First seen</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{formatDateTime(group.firstSeen)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Last seen</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{formatDateTime(group.lastSeen)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">State</dt>
              <dd className="m-0 text-right text-md text-ink-1">
                {group.open ? "Open" : "Acknowledged"}
              </dd>
            </div>
          </dl>
        </Card>

        <Card title="Affected connection" className="fd-conn">
          {connector ? (
            <div className="flex flex-wrap items-center gap-3">
              <HealthBadge health={HEALTH_OF[connector.status]} />
              <div className="min-w-0 flex-1">
                <div className="text-lg font-semibold text-ink-1">{connector.label}</div>
                <div className="mono text-xs text-ink-3">
                  {connector.terminus} · {connector.reading}
                </div>
              </div>
              <button
                type="button"
                className={BTN}
                onClick={() => navigate("connections", connector.id)}
              >
                Open connection
                <IconChevronRight />
              </button>
            </div>
          ) : (
            <EmptyState title="No linked connection" lead="This finding is not attributed to a known connection." />
          )}
        </Card>
      </div>

      {/*
        EVERY OCCURRENCE, INDIVIDUALLY.

        The card on the list says "16 occurrences", which tells an operator the
        scale and nothing about the shape — when did it start flapping, was it
        steady, did it stop. Those are the questions the page exists to answer,
        and they cannot be answered from a count. Every occurrence is therefore
        listed with its own time and its own acknowledgement state, and each can
        be acknowledged on its own.

        A group stays open while ANY occurrence is open, so the header counts what
        is outstanding rather than repeating the total the card already showed.
      */}
      <Card
        title="Occurrences"
        meta={
          group.open
            ? `${group.openCount} of ${occurrences.length} acknowledged`
            : `All ${occurrences.length} acknowledged`
        }
      >
        {group.open && (
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Can ability={ABILITY.findingAck}>
              <button
                type="button"
                className={BTN_OUTLINE}
                disabled={ackBusy}
                onClick={() => onAck(openIds)}
              >
                <IconCheck />
                {ackBusy
                  ? "Acknowledging…"
                  : `Acknowledge all ${group.openCount} open ${plural(group.openCount, "occurrence", "occurrences")}`}
              </button>
            </Can>
            <span className="text-xs text-ink-3">
              Acknowledged occurrences are recorded individually and keep their operator.
            </span>
          </div>
        )}

        <CollapsibleList
          id="fd-occurrences"
          countLabel={`${listedOccurrences.length} of ${occurrences.length} occurrences shown`}
          summary={`${group.openCount} open · first ${formatDateTime(group.firstSeen)} · last ${formatDateTime(group.lastSeen)}`}
          items={listedOccurrences}
          keyOf={(occurrence) => occurrence.id}
          empty={
            <EmptyState
              title="Nothing to show"
              lead="Every occurrence of this incident has been acknowledged."
            />
          }
          headerControl={
            acknowledgedCount > 0 ? (
              <button
                type="button"
                onClick={() => setShowAcknowledged((v) => !v)}
                aria-pressed={showAcknowledged}
                className={cx(BTN, "ml-auto")}
              >
                {showAcknowledged
                  ? `Hide acknowledged (${acknowledgedCount})`
                  : `Show acknowledged (${acknowledgedCount})`}
              </button>
            ) : null
          }
          renderItem={(occurrence) => (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule-enamel py-2 last:border-b-0">
              <span className="mono min-w-0 flex-1 text-xs text-ink-2 wrap-anywhere">
                {formatDateTime(occurrence.since)}
                <span className="ml-2 text-ink-3">{formatAge(occurrence.since)} ago</span>
              </span>

              {occurrence.acknowledgedAt ? (
                <span className="mono text-xs text-ink-3 wrap-anywhere">
                  Acknowledged{occurrence.acknowledgedBy ? ` by ${occurrence.acknowledgedBy}` : ""}
                </span>
              ) : (
                /* Withheld rather than disabled, exactly as on the card: there is
                   nothing to do for an occurrence already acknowledged, and
                   re-acknowledging would overwrite the recorded operator. */
                <Can ability={ABILITY.findingAck}>
                  <button
                    type="button"
                    className={BTN}
                    disabled={ackBusy}
                    onClick={() => onAck([occurrence.id])}
                    title="Acknowledge this occurrence"
                  >
                    Acknowledge
                  </button>
                </Can>
              )}
            </div>
          )}
        />

        {ackError && <div className="mt-3 text-sm text-text-suspended" role="alert">{ackError}</div>}
      </Card>

      {/*
        Related events, already scoped to this incident by the same matcher the
        "View event log" link uses — so the two views cannot disagree about what
        belongs to it. The button is withheld when there is nothing to open,
        rather than navigating to a log that would say so itself.
      */}
      <Card
        title="Related events"
        meta={`${related.length} on ${group.channel}`}
        className="fd-events"
      >
        {related.length === 0 ? (
          <EmptyState title="No related events" lead="No operational events were recorded on this channel while this incident was reported." />
        ) : (
          <>
            <EventStream events={recent} />
            {hiddenEventCount > 0 && (
              <p className="mono mt-2 text-xs text-ink-3">
                Showing the {RECENT_EVENTS} most recent of {related.length}. The event log
                below carries all of them.
              </p>
            )}
            <div className="mt-3">
              <button
                type="button"
                className={BTN}
                onClick={() => {
                  /*
                    The link carries the MATCHED EVENT IDS, not a description of
                    the incident for the log to re-derive. `relatedEventsFor` has
                    already made that decision on this page; asking the log to
                    repeat it would mean two implementations of one question,
                    free to disagree.
                  */
                  const url = new URL(window.location.href);
                  url.hash = `#/events?ids=${related.map((e) => e.id).join(",")}&incident=${groupKey(group)}`;
                  window.location.assign(url.toString());
                }}
              >
                View event log for this incident
                {hiddenEventCount > 0 && (
                  <span className="mono text-xs text-ink-3"> ({related.length})</span>
                )}
                <IconChevronRight />
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
