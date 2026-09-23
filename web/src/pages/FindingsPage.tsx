/* Findings — the attention queue, plus the incident detail view.
 *
 * A finding is the operator-facing record of something that needs action.
 * It follows the flow: Finding → incident detail → related events →
 * connector, so no card is a dead end. */

import { useState } from "react";
import type { Connector, Failure, LifecycleEvent, PolicyScope } from "@/types/domain";
import { HEALTH_OF } from "@/utils/vocabulary";
import { BTN, BTN_PRIMARY, Card, cx, EmptyState, FindingCard, HealthBadge, LINK_BTN, PageHeader, SearchBox, SeverityBadge } from "@/components/ui";
import { Can, Cannot } from "@/components/Can";
import { EventStream } from "@/components/Tables";
import { IconChevronRight, IconPolicy } from "@/components/icons";
import { ABILITY } from "@/utils/permissions";
import { navigate } from "@/router";

type Filter = "all" | "critical" | "attention";

/* The severity filter is a segmented control: one geometry, two treatments.
   The weight travels with the state too, so it sits in each treatment rather
   than the base — two `font-*` utilities on one element would resolve by
   stylesheet order, not by the order they are written here. */
const FILTER_BTN =
  "inline-flex cursor-pointer items-center gap-2 rounded-chip border border-rule-enamel bg-midnight-2 px-3 py-1.5 text-sm hover:border-ink-4 hover:text-ink-1";
const FILTER_ON = "border-primary bg-sel-bg font-semibold text-ink-1";
const FILTER_OFF = "font-medium text-ink-2";

export function FindingsPage({
  findings,
  connectors,
  onAck,
  ackError,
  activePolicy,
}: {
  findings: Failure[];
  connectors: Connector[];
  onAck: (id: string) => void;
  ackError: string | null;
  activePolicy: PolicyScope | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const critical = findings.filter((f) => f.severity === "critical").length;
  const warning = findings.length - critical;

  const filtered = findings
    .filter((f) => (filter === "all" ? true : f.severity === filter))
    .filter((f) =>
      query
        ? f.title.toLowerCase().includes(query.toLowerCase()) ||
          f.id.toLowerCase().includes(query.toLowerCase()) ||
          f.channel.toLowerCase().includes(query.toLowerCase())
        : true,
    )
    .sort((a, b) => (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1));

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="Findings"
        lead="Everything that needs an operator's attention, ranked by severity. Acknowledging a finding records that it has been seen; it stays in the log."
        actions={
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search findings"
            label="Search findings"
          />
        }
      />

      <section className="flex flex-wrap gap-2" aria-label="Finding filters">
        {(
          [
            { id: "all", label: "All", count: findings.length },
            { id: "critical", label: "Critical", count: critical },
            { id: "attention", label: "Warning", count: warning },
          ] as Array<{ id: Filter; label: string; count: number }>
        ).map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={cx(FILTER_BTN, opt.id === filter ? FILTER_ON : FILTER_OFF)}
            aria-pressed={opt.id === filter}
            onClick={() => setFilter(opt.id)}
          >
            {opt.label}
            <span className={cx("mono text-xs", opt.id === filter ? "text-primary-ink" : "text-ink-3")}>{opt.count}</span>
          </button>
        ))}
      </section>

      {activePolicy && (
        <div className="mb-3 flex items-center gap-2 rounded-panel bg-midnight-3 px-3 py-2 text-sm text-ink-2 [&_svg]:text-line-amber" data-readonly={activePolicy.readOnly}>
          <IconPolicy />
          {activePolicy.readOnly
            ? `Read-only scope (${activePolicy.label}) — findings can be inspected but not acknowledged.`
            : `${activePolicy.label} — can acknowledge and act within scope.`}
        </div>
      )}

      {ackError && <div className="mt-3 text-sm text-text-suspended" role="alert">{ackError}</div>}

      {filtered.length === 0 ? (
        <EmptyState
          title={findings.length === 0 ? "No open findings" : "No findings match this filter"}
          lead={
            findings.length === 0
              ? "Every connection is healthy and the synchronisation loop is within SLA. New findings appear here the moment they are logged."
              : "Try a different severity, or clear the search term."
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((f) => {
            const conn = connectors.find((c) => c.label === f.channel);
            return (
              <div className="flex flex-col gap-2" key={f.id}>
                <FindingCard
                  finding={f}
                  onAck={onAck}
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
      )}
    </div>
  );
}

/** Incident detail: /findings/:id */
export function FindingDetailPage({
  finding,
  connectors,
  events,
  onAck,
  ackError,
}: {
  finding: Failure | undefined;
  connectors: Connector[];
  events: LifecycleEvent[];
  onAck: (id: string) => void;
  ackError: string | null;
}) {
  if (!finding) {
    return (
      <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
        <PageHeader title="Finding not found" lead="This finding is not in the current data set." />
        <EmptyState
          title="No such finding"
          lead="It may have been resolved and cleared, or the link may be stale."
          action={
            <button type="button" className={BTN} onClick={() => navigate("findings")}>
              Back to findings
            </button>
          }
        />
      </div>
    );
  }

  const conn = connectors.find((c) => c.label === finding.channel);
  const related = events.filter((e) => e.channel === finding.channel);

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <nav className="mono flex items-center gap-2 text-xs text-ink-3 [&_svg]:size-3" aria-label="Breadcrumb">
        <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-ink-2 underline underline-offset-[0.18em] hover:text-ink-1" onClick={() => navigate("findings")}>
          Findings
        </button>
        <IconChevronRight />
        <span aria-current="page">{finding.id}</span>
      </nav>

      <PageHeader
        title={finding.title}
        lead={`${finding.channel} · started ${finding.since} · ongoing`}
        actions={<SeverityBadge severity={finding.severity} />}
      />

      <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-2xl:grid-cols-[minmax(0,1fr)]">
        <Card title="Operational impact" className="fd-impact">
          <p>{finding.detail}</p>
          <dl className="flex flex-col">
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Finding</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{finding.id}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Severity</dt>
              <dd className="m-0 text-right text-md text-ink-1">
                <SeverityBadge severity={finding.severity} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Started</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{finding.since}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">State</dt>
              <dd className="m-0 text-right text-md text-ink-1">Ongoing</dd>
            </div>
          </dl>
        </Card>

        <Card title="Affected connection" className="fd-conn">
          {conn ? (
            <div className="flex flex-wrap items-center gap-3">
              <HealthBadge health={HEALTH_OF[conn.status]} />
              <div className="min-w-0 flex-1">
                <div className="text-lg font-semibold text-ink-1">{conn.label}</div>
                <div className="mono text-xs text-ink-3">
                  {conn.terminus} · {conn.reading}
                </div>
              </div>
              <button
                type="button"
                className={BTN}
                onClick={() => navigate("connections", conn.id)}
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

      <Card
        title="Actions"
        className="fd-actions"
        meta={<Can ability={ABILITY.findingAck} fallback="read-only scope" />}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Can ability={ABILITY.findingAck}>
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => onAck(finding.id)}
              title="Acknowledge this finding"
            >
              Acknowledge
            </button>
          </Can>
          <button type="button" className={BTN} onClick={() => navigate("events")}>
            View event log
          </button>
        </div>
        <Cannot ability={ABILITY.findingAck}>
          <p className="mono mt-3 text-xs text-ink-3">
            Acknowledging requires the <code>ack</code> action on the dashboard scope.
          </p>
        </Cannot>
        {ackError && <div className="mt-3 text-sm text-text-suspended" role="alert">{ackError}</div>}
      </Card>

      <Card title="Related events" meta={`${related.length} on this channel`} className="fd-events">
        {related.length === 0 ? (
          <EmptyState title="No related events" lead="No operational events were recorded on this channel." />
        ) : (
          <EventStream events={related} />
        )}
      </Card>
    </div>
  );
}
