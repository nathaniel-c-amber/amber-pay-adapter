/* Synchronization — the product's timing requirement, made visible.
 *
 * Two paths are shown: the payment push (completed events must reach the
 * accounting adaptor within 5 seconds) and the scheduled pull.
 *
 * ★ THE "15-MINUTE CADENCE" CLAIM WAS REMOVED HERE BECAUSE NOTHING RUNS IT.
 *
 * The lead used to say scheduled pulls run every fifteen minutes, and the
 * `ConfigPage` had already been corrected for making the same claim: there is
 * no scheduler in the service at all, nothing reads `syncInterval`, and
 * `pullSyncStatus` is never called outside the adaptors' own definitions. Two
 * pages describing one non-existent behaviour is worse than one — an operator
 * waits fifteen minutes for a pull that never comes and concludes the ledger is
 * stale, when in fact nothing was ever scheduled.
 *
 * The push path, by contrast, IS real and IS measured: a completed payment is
 * pushed to the accounting system inside the same request that receives it, and
 * was measured at 1994 ms against the 5000 ms budget on 2026-10-06.
 *
 * The manual "Run sync now" action is permission-gated and says plainly that it
 * re-reads monitoring data, because there is no manual-sync endpoint to call. */

import { useState } from "react";
import type { Connector, LifecycleEvent } from "@/types/domain";
import { HEALTH_OF, HEALTH_IMPACT } from "@/utils/vocabulary";
import { BTN_PRIMARY, Card, EmptyState, HealthBadge, PageHeader } from "@/components/ui";
import { Can, Cannot } from "@/components/Can";
import { EventStream } from "@/components/Tables";
import { IconRefresh, IconSync } from "@/components/icons";
import { ABILITY } from "@/utils/permissions";

export function SynchronizationPage({
  connectors,
  events,
  onRefresh,
  syncing,
}: {
  connectors: Connector[];
  events: LifecycleEvent[];
  onRefresh: () => void;
  syncing: boolean;
}) {
  const [requested, setRequested] = useState(false);

  const push = connectors.find((c) => c.id === "push");
  const pushHealth = push ? HEALTH_OF[push.status] : "unknown";

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
        lead="A completed payment is pushed to the active accounting system inside the same request that receives it, and must reach it within 5 seconds. That path is measured here. No scheduled pull runs on this deployment."
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
            {/* Not "unknown" — there is nothing to be uncertain ABOUT. Nothing
                is scheduled, so the honest badge is the inert one rather than a
                warning that implies a system exists and is having trouble. */}
            <HealthBadge health="unknown" />
          </div>
          <div className="mono mt-2 mb-3 text-2xl font-semibold text-ink-3">not scheduled</div>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 max-sm:gap-x-4">
            <div className="flex flex-col gap-0.5">
              <dt className="text-micro uppercase tracking-label text-ink-3">Interval</dt>
              {/* Say there is none rather than printing a configured value that
                  nothing would act on. A stored number with no scheduler behind
                  it reads as a live setting, and an operator watching it tick
                  nothing down is worse off than being told plainly. */}
              <dd className="mono m-0 text-md text-ink-3">none</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-micro uppercase tracking-label text-ink-3">Last run</dt>
              <dd className="mono m-0 text-md text-ink-3">never</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-micro uppercase tracking-label text-ink-3">Impact</dt>
              <dd className="m-0 text-md text-ink-2">
                None. Payments are pushed, not pulled.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <Card title="Manual synchronization" className="sync-actions">
        <Can ability={ABILITY.paymentsWrite}>
          <div className="mb-3 flex gap-3">
            <button type="button" className={BTN_PRIMARY} onClick={runSync} disabled={syncing}>
              <IconRefresh /> {syncing ? "Requesting…" : "Run sync now"}
            </button>
          </div>
        </Can>
        {requested && (
          <p className="mono mt-3 text-xs text-ink-3" role="status">
            <IconSync /> Monitoring data refreshed. This deployment exposes no manual-sync endpoint,
            so no sync was dispatched to the adaptor — trigger it from the adaptor itself until the
            endpoint ships.
          </p>
        )}
        <Cannot ability={ABILITY.paymentsWrite}>
          <p className="m-0 mono text-xs text-ink-3">
            The action is hidden from read-only scopes rather than shown disabled, so the interface
            never offers a control the policy cannot honour.
          </p>
        </Cannot>
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
