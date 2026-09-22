/* Payments — the operational payment lifecycle.
 *
 * Shows the payment-processing side of the chain with reference hashes and
 * statuses only. There is deliberately no amount, currency, or customer
 * field anywhere on this surface (FR-2.3 / FR-5.2), and the create action is
 * gated on write access to the payments scope. */

import { useState } from "react";
import type { LifecycleEvent } from "@/types/domain";
import type { ReconciliationReport } from "@/services/client";
import { BTN_PRIMARY, Card, EmptyState, Kpi, PageHeader, PermissionGuard, SearchBox } from "@/components/ui";
import { EventStream } from "@/components/Tables";
import { IconCard, IconRefresh } from "@/components/icons";

export function PaymentsPage({
  events,
  recon,
  canWrite,
  mode,
}: {
  events: LifecycleEvent[];
  recon: ReconciliationReport;
  canWrite: boolean;
  mode: "demo" | "live";
}) {
  const [query, setQuery] = useState("");
  const summary = recon.reconciliation;

  // Payment-side lifecycle phases only; the accounting side lives under
  // Synchronization and Reconciliation.
  const paymentEvents = events.filter(
    (e) =>
      e.channel.toLowerCase().includes("payment") ||
      e.type === "initiated" ||
      e.type === "collected" ||
      e.type === "payment-declined" ||
      e.type === "payment-failed",
  );

  const filtered = query
    ? paymentEvents.filter(
        (e) =>
          e.detail.toLowerCase().includes(query.toLowerCase()) ||
          e.ref.toLowerCase().includes(query.toLowerCase()),
      )
    : paymentEvents;

  const declined = events.filter(
    (e) => e.type === "payment-declined" || e.type === "payment-failed",
  ).length;

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="Payments"
        lead="Payment processing status as it flows from Amber Pay toward the accounting adaptor. References and statuses only — no amounts and no customer data."
        actions={
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search reference or detail"
            label="Search payment events"
          />
        }
      />

      <section className="grid grid-cols-4 gap-3 max-4xl:grid-cols-2 max-sm:grid-cols-1" aria-label="Payment readouts">
        <Kpi
          label="Payment events"
          value={paymentEvents.length}
          note="in the current window"
          tone="neutral"
          icon={<IconCard />}
        />
        <Kpi
          label="Declined / failed"
          value={declined}
          note={declined > 0 ? "see event log" : "none in window"}
          tone={declined > 0 ? "warn" : "good"}
          icon={<IconCard />}
        />
        <Kpi
          label="Reconciliation"
          value={summary ? summary.status : "—"}
          note={
            summary?.ranAt
              ? `ran ${new Date(summary.ranAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "not yet run"
          }
          tone={summary?.status === "completed" ? "good" : summary?.status === "running" ? "neutral" : "warn"}
          icon={<IconRefresh />}
        />
        <Kpi
          label="Unmatched"
          value={summary ? summary.unmatched : "—"}
          note={summary && summary.unmatched > 0 ? "need review" : "all matched"}
          tone={summary && summary.unmatched > 0 ? "warn" : "good"}
          icon={<IconCard />}
        />
      </section>

      <Card
        title="Create a payment"
        meta={canWrite ? "authorized" : "restricted"}
        className="pm-create"
      >
        <PermissionGuard
          allowed={canWrite}
          reason="Creating a payment requires write access on the payments scope."
        >
          <div className="mb-3 flex gap-3">
            <button type="button" className={BTN_PRIMARY}>
              <IconCard /> Create payment link
            </button>
          </div>
        </PermissionGuard>
      </Card>

      <Card
        title="Payment lifecycle"
        meta={<span className="mono">{filtered.length} events · {mode === "demo" ? "synthetic" : "live"}</span>}
        className="pm-events"
      >
        {filtered.length === 0 ? (
          <EmptyState
            title={paymentEvents.length === 0 ? "No payment events" : "No events match this search"}
            lead={
              paymentEvents.length === 0
                ? "Payment lifecycle events will appear here as payments are initiated and collected."
                : "Try a different reference or detail term."
            }
          />
        ) : (
          <EventStream events={filtered} />
        )}
      </Card>
    </div>
  );
}
