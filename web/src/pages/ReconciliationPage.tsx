/* Reconciliation — matching operational counts.
 *
 * The reconciliation report exposes counts and timestamps only (matched,
 * unmatched, anomalies). There is no monetary value on this surface, by
 * design. */

import type { ReconciliationReport } from "@/services/client";
import type { LifecycleEvent } from "@/types/domain";
import { Card, EmptyState, Kpi, PageHeader } from "@/components/ui";
import { EventStream } from "@/components/Tables";
import { formatDateTime, formatDateTimeSeconds } from "@/utils/datetime";
import { IconAlert, IconCard, IconCheck, IconRefresh } from "@/components/icons";

export function ReconciliationPage({
  recon,
  events,
  mode,
}: {
  recon: ReconciliationReport;
  events: LifecycleEvent[];
  mode: "demo" | "live";
}) {
  const summary = recon.reconciliation;
  const statusTone =
    summary?.status === "completed" ? "good" : summary?.status === "running" ? "neutral" : "warn";

  const reconEvents = events.filter(
    (e) => e.type === "sync-change" || e.channel.toLowerCase().includes("pull"),
  );

  const counts = summary
    ? [
        { label: "Matched", value: summary.matched, note: "records reconciled", tone: "good" as const, icon: <IconCheck /> },
        {
          label: "Unmatched",
          value: summary.unmatched,
          note: summary.unmatched > 0 ? "need review" : "none outstanding",
          tone: summary.unmatched > 0 ? ("warn" as const) : ("good" as const),
          icon: <IconCard />,
        },
        {
          label: "Anomalies",
          value: summary.anomalies,
          note: summary.anomalies > 0 ? "flagged for ops" : "none flagged",
          tone: summary.anomalies > 0 ? ("bad" as const) : ("good" as const),
          icon: <IconAlert />,
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="Reconciliation"
        lead="How well the payment records and the accounting records agree. Counts and timestamps only — the console never carries ledger amounts."
        actions={
          <span className="mono text-sm text-ink-2">
            {summary ? `status ${summary.status}` : "no run recorded"} · {mode === "demo" ? "synthetic" : "live"}
          </span>
        }
      />

      {!summary ? (
        <EmptyState
          title="No reconciliation run recorded"
          lead="Once a reconciliation job runs, its matched, unmatched, and anomaly counts will appear here. Until then there is nothing to report."
        />
      ) : (
        <>
          <section className="grid grid-cols-4 gap-3 max-4xl:grid-cols-2 max-sm:grid-cols-1" aria-label="Reconciliation readouts">
            <Kpi
              label="Status"
              value={summary.status}
              note={summary.ranAt ? `ran ${formatDateTime(summary.ranAt)}` : "time unknown"}
              tone={statusTone}
              icon={<IconRefresh />}
            />
            {counts.map((c) => (
              <Kpi key={c.label} label={c.label} value={c.value} note={c.note} tone={c.tone} icon={c.icon} />
            ))}
          </section>

          <Card title="Run detail" className="rec-detail">
            <dl className="flex flex-col">
              <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
                <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Report generated</dt>
                <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">
                  {recon.generatedAt ? formatDateTimeSeconds(recon.generatedAt) : "—"}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
                <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Job status</dt>
                <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{summary.status}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
                <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Financial data</dt>
                <dd className="m-0 text-right text-md text-ink-1">Not collected — operational counts only (FR-2.3 / FR-5.2)</dd>
              </div>
            </dl>
          </Card>

          <Card
            title="Reconciliation events"
            meta={<span className="mono">{reconEvents.length} recent</span>}
            className="rec-events"
          >
            {reconEvents.length === 0 ? (
              <EmptyState
                title="No reconciliation events"
                lead="Sync and pull events related to reconciliation will appear here."
              />
            ) : (
              <EventStream events={reconEvents} />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
