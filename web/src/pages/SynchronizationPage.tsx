/* Synchronization — the product's timing requirement, made visible.
 *
 * Two paths are shown: the payment push (completed events must reach the
 * accounting adaptor within 5 seconds) and the scheduled pull (15-minute
 * cadence). The manual "Run sync now" action is permission-gated and only
 * rendered for scopes that can write.
 *
 * NOTE (flagged, not silently resolved): the backend exposes no
 * manual-sync endpoint — /api/v1 has auth, dashboard, failures, payments,
 * reports, and webhooks routes only. The action therefore re-reads
 * monitoring data and says so plainly rather than reporting a success it
 * cannot verify. See the run summary for this gap. */

import { useState } from "react";
import type { Connector, LifecycleEvent } from "@/types/domain";
import { HEALTH_OF, HEALTH_IMPACT } from "@/utils/vocabulary";
import { BTN_PRIMARY, Card, EmptyState, HealthBadge, PageHeader, PermissionGuard } from "@/components/ui";
import { EventStream } from "@/components/Tables";
import { IconRefresh, IconSync } from "@/components/icons";

export function SynchronizationPage({
  connectors,
  events,
  canWrite,
  onRefresh,
  syncing,
}: {
  connectors: Connector[];
  events: LifecycleEvent[];
  canWrite: boolean;
  onRefresh: () => void;
  syncing: boolean;
}) {
  const [requested, setRequested] = useState(false);

  const push = connectors.find((c) => c.id === "push");
  const pull = connectors.find((c) => c.id === "pull");
  const pushHealth = push ? HEALTH_OF[push.status] : "unknown";
  const pullHealth = pull ? HEALTH_OF[pull.status] : "unknown";
  const pullDelayed = pullHealth === "degraded" || pullHealth === "failed";

  const syncEvents = events.filter(
    (e) => e.type === "sync-change" || e.channel.toLowerCase().includes("pull"),
  );

  const runSync = () => {
    setRequested(true);
    onRefresh();
  };

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="Synchronization"
        lead="Completed payment events must reach the active accounting adaptor within 5 seconds, and scheduled pulls run on a 15-minute cadence. Both paths are measured here."
      />

      <section className="grid grid-cols-2 gap-3 max-sm:grid-cols-1" aria-label="Synchronisation readouts">
        <div className="rounded-panel border border-rule-enamel bg-midnight-2 px-5 py-4 shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-lg font-semibold text-ink-1">Payment push</span>
            <HealthBadge health={pushHealth} />
          </div>
          <div className="mono mt-2 mb-3 text-2xl font-semibold text-ink-1">{push ? push.reading : "—"}</div>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 max-sm:gap-x-4">
            <div className="flex flex-col gap-0.5">
              <dt className="text-micro uppercase tracking-label text-ink-3">Target</dt>
              <dd className="mono m-0 text-md text-ink-1">≤ 5s</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-micro uppercase tracking-label text-ink-3">SLA</dt>
              <dd className="mono m-0 text-md text-ink-1">{pushHealth === "healthy" ? "within SLA" : "outside SLA"}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-micro uppercase tracking-label text-ink-3">Impact</dt>
              <dd className="m-0 text-md text-ink-1">{HEALTH_IMPACT[pushHealth]}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-panel border border-rule-enamel bg-midnight-2 px-5 py-4 shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-lg font-semibold text-ink-1">Scheduled pull</span>
            <HealthBadge health={pullHealth} />
          </div>
          <div className="mono mt-2 mb-3 text-2xl font-semibold text-ink-1">{pullDelayed ? "delayed" : "on schedule"}</div>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 max-sm:gap-x-4">
            <div className="flex flex-col gap-0.5">
              <dt className="text-micro uppercase tracking-label text-ink-3">Interval</dt>
              <dd className="mono m-0 text-md text-ink-1">{pull ? pull.reading : "—"}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-micro uppercase tracking-label text-ink-3">Last run</dt>
              <dd className="mono m-0 text-md text-ink-1">{pull ? pull.note.replace(/^last run /i, "") : "—"}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-micro uppercase tracking-label text-ink-3">Impact</dt>
              <dd className="m-0 text-md text-ink-1">{HEALTH_IMPACT[pullHealth]}</dd>
            </div>
          </dl>
        </div>
      </section>

      <Card
        title="Manual synchronization"
        meta={canWrite ? "authorized" : "restricted"}
        className="sync-actions"
      >
        <PermissionGuard
          allowed={canWrite}
          reason="Running a sync requires write access on the payments scope."
        >
          <div className="mb-3 flex gap-3">
            <button type="button" className={BTN_PRIMARY} onClick={runSync} disabled={syncing}>
              <IconRefresh /> {syncing ? "Requesting…" : "Run sync now"}
            </button>
          </div>
        </PermissionGuard>
        {requested && (
          <p className="mono mt-3 text-xs text-ink-3" role="status">
            <IconSync /> Monitoring data refreshed. This deployment exposes no manual-sync endpoint,
            so no sync was dispatched to the adaptor — trigger it from the adaptor itself until the
            endpoint ships.
          </p>
        )}
        {!canWrite && (
          <p className="mono mt-3 text-xs text-ink-3">
            The action is hidden from read-only scopes rather than shown disabled, so the interface
            never offers a control the policy cannot honour.
          </p>
        )}
      </Card>

      <Card
        title="Synchronization events"
        meta={<span className="mono">{syncEvents.length} recent</span>}
        className="sync-events"
      >
        {syncEvents.length === 0 ? (
          <EmptyState
            title="No synchronization events"
            lead="Pull and sync-status events will appear here as the scheduled loop runs."
          />
        ) : (
          <EventStream events={syncEvents} />
        )}
      </Card>
    </div>
  );
}
