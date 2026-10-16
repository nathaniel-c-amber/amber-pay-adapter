/* Connections — the operational paths, and the redesigned service map.
 *
 * Keeps the existing network-map capability but reframes it as a detail
 * experience (the brief demotes topology from hero to secondary), and adds a
 * per-connection detail view so every row drills down. */

import type { Connector, Failure, LifecycleEvent } from "@/types/domain";
import { HEALTH_OF, HEALTH_IMPACT, healthCounts } from "@/utils/vocabulary";
import { formatDateTime } from "@/utils/datetime";
import { adaptorRefsForGroup, groupFindings } from "@/utils/findings";
import { BTN, Card, ConnectionRow, EmptyState, HealthBadge, PageHeader, SeverityBadge } from "@/components/ui";
import { NetworkMap } from "@/components/NetworkMap";
import { CollapsibleList } from "@/components/CollapsibleList";
import { EventStream } from "@/components/Tables";
import { IconChevronRight, IconPolicy } from "@/components/icons";
import { navigate } from "@/router";

export function ConnectionsPage({
  connectors,
  events,
  activeId,
  onFocus,
  mode,
}: {
  connectors: Connector[];
  events: LifecycleEvent[];
  activeId: string | null;
  onFocus: (id: string | null) => void;
  mode: "demo" | "live";
}) {
  const counts = healthCounts(connectors.map((c) => c.status));

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="Connections"
        lead="Every operational path between Amber Pay and the accounting adaptors, with its current health and last observed activity."
        actions={
          <span className="mono text-sm text-ink-2">
            {counts.healthy} healthy
            {counts.degraded > 0 ? ` · ${counts.degraded} degraded` : ""}
            {counts.failed > 0 ? ` · ${counts.failed} failed` : ""}
          </span>
        }
      />

      <Card title="All connections" className="cn-list" meta="click a path for detail">
        <div className="flex flex-col" role="list" aria-label="Operational connections">
          {connectors.map((c) => (
            <ConnectionRow key={c.id} connector={c} onOpen={(id) => navigate("connections", id)} />
          ))}
        </div>
      </Card>

      <Card
        title="Service map"
        meta={<span className="mono">{mode === "demo" ? "synthetic · " : ""}gateway → ledger</span>}
        className="cn-map"
      >
        <p className="mb-3 text-sm text-ink-2">
          Read left to right: payments enter at the gateway, pass this deployment's hub, and
          land as records in the accounting system. A line is solid while that route is healthy,
          dashed while it is degraded, and hatched with a broken line when it has failed — so the
          state never rests on colour alone. With several routes on one pipe, the pipe shows the
          worst of them; the key underneath lists each separately.
        </p>
        <NetworkMap connectors={connectors} activeId={activeId} onFocus={onFocus} />
      </Card>

      <Card
        title="Recent activity across all paths"
        meta="operational events only"
        className="cn-events"
      >
        <EventStream events={events.slice(0, 8)} />
      </Card>

      {/* Scope note: the map is read-only under every scope that can reach it. */}
      <p className="mono mt-3 text-xs text-ink-3">
        <span className="inline-block -mb-1"><IconPolicy /></span> Connection state is reported by the adaptors and cannot be edited from this
        console.
      </p>
    </div>
  );
}

/** Detail view for a single connection: /connections/:id */
export function ConnectionDetailPage({
  connector,
  connectors,
  events,
  failures,
  activeId,
  onFocus,
}: {
  connector: Connector | undefined;
  /** The full topology, so the focused path is shown in context rather than
   *  floating alone — the map's job is to show where a failure sits. */
  connectors: Connector[];
  events: LifecycleEvent[];
  failures: Failure[];
  activeId: string | null;
  onFocus: (id: string | null) => void;
}) {
  if (!connector) {
    return (
      <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
        <PageHeader title="Connection not found" lead="This connection is not available in the current data set." />
        <EmptyState
          title="No such connection"
          lead="It may have been removed, or the link may be stale."
          action={
            <button type="button" className={BTN} onClick={() => navigate("connections")}>
              Back to connections
            </button>
          }
        />
      </div>
    );
  }

  const health = HEALTH_OF[connector.status];
  /*
    A CONNECTOR'S INCIDENTS AND EVENTS, joined on the adaptor id.

    Both lines used to compare `channel` against `connector.label` — "accounting"
    against "QuickBooks Online" — which never matches, so this page always said
    the connection had no findings and no events regardless of what had actually
    happened to it. A connector's `id` and an event's `ref` are both the adaptor
    id, and `adaptorRefsForGroup` is the same helper the incident page uses, so
    both directions of the link are decided in one place.
  */
  const relatedEvents = events.filter((e) => e.ref === connector.id);
  const related = groupFindings(failures)
    .filter((group) => adaptorRefsForGroup(group, events).has(connector.id))
    .flatMap((group) => group.members);

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <nav className="mono flex items-center gap-2 text-xs text-ink-3 [&_svg]:size-3" aria-label="Breadcrumb">
        <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-ink-2 underline underline-offset-[0.18em] hover:text-ink-1" onClick={() => navigate("connections")}>
          Connections
        </button>
        <IconChevronRight />
        <span aria-current="page">{connector.label}</span>
      </nav>

      <PageHeader
        title={connector.label}
        lead={
          <>
            {connector.terminus} · {connector.note}
          </>
        }
        actions={<HealthBadge health={health} live={connector.status === "open" && connector.reading.toLowerCase().includes("live")} />}
      />

      <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-2xl:grid-cols-[minmax(0,1fr)]">
        <Card title="State" className="cd-state">
          <dl className="flex flex-col">
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Health</dt>
              <dd className="m-0 text-right text-md text-ink-1">
                <HealthBadge health={health} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Readout</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{connector.reading}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Terminus</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{connector.terminus}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Impact</dt>
              <dd className="m-0 text-right text-md text-ink-1">{HEALTH_IMPACT[health]}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Related findings" className="cd-findings">
          <CollapsibleList
            id="cd-findings"
            countLabel={`${related.length} open ${related.length === 1 ? "finding" : "findings"}`}
            summary={
              related.length === 0
                ? "Nothing recorded against this connection."
                : `Latest ${related[0]?.title ?? ""} · ${formatDateTime(related[0]?.since ?? null)}`
            }
            items={related}
            keyOf={(f) => f.id}
            renderItem={(f) => (
              <button
                type="button"
                className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_14px] items-center gap-3 rounded-panel border-b border-rule-enamel-soft bg-transparent px-1.5 py-2 text-left transition-colors hover:bg-midnight-3 [&_svg]:text-ink-3"
                onClick={() => navigate("findings", f.id)}
              >
                <SeverityBadge severity={f.severity} />
                <span className="text-md text-ink-1">{f.title}</span>
                <span className="mono text-xs text-ink-3">{formatDateTime(f.since)}</span>
                <IconChevronRight />
              </button>
            )}
            empty={<EmptyState title="No open findings" lead="This connection has no findings recorded against it." />}
            overflowHref={{ label: "Open the event log", onClick: () => navigate("events") }}
          />
        </Card>
      </div>

      <Card
        title="Route in context"
        meta={<span className="mono">{connector.label} highlighted</span>}
        className="cd-map"
      >
        <p className="mb-3 text-sm text-ink-2">
          The full hub, with this connection's route isolated so you can see where it sits and
          where it stops.
        </p>
        <NetworkMap
          connectors={connectors}
          activeId={activeId ?? connector.id}
          onFocus={onFocus}
        />
      </Card>

      <Card title="Events on this path" className="cd-events">
        <CollapsibleList
          id="cd-events"
          countLabel={`${relatedEvents.length} recent ${relatedEvents.length === 1 ? "event" : "events"}`}
          summary={
            relatedEvents.length === 0
              ? "Nothing recorded on this path."
              : `Latest ${relatedEvents[0]?.detail ?? ""} · ${formatDateTime(relatedEvents[0]?.at ?? null)}`
          }
          items={relatedEvents}
          keyOf={(e) => e.id}
          renderItem={(e) => (
            /*
              One row, not one `EventStream` per event.

              `EventStream` is a table — it builds a header, a column model and a
              sorter per instance. Rendering it per row would have produced five
              stacked tables each with its own header row, which is neither a list
              nor a table. The row below carries the same fields the table does.
            */
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule-enamel-soft py-2">
              <span className="mono text-xs text-ink-3 whitespace-nowrap">
                {formatDateTime(e.at)}
              </span>
              <span className="mono text-xs text-ink-1">{e.type}</span>
              <span className="mono text-xs text-ink-3">{e.ref}</span>
              <span className="min-w-0 flex-1 text-sm text-ink-2 wrap-anywhere">
                {e.detail}
              </span>
            </div>
          )}
          empty={<EmptyState title="No recent events" lead="No operational events have been recorded for this path recently." />}
          overflowHref={{ label: "Open the event log", onClick: () => navigate("events") }}
        />
      </Card>
    </div>
  );
}
