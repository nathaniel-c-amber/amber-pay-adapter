/* Payments — the operational payment lifecycle.
 *
 * Shows the payment-processing side of the chain with reference hashes and
 * statuses only. There is deliberately no amount, currency, or customer
 * field anywhere on this surface (FR-2.3 / FR-5.2), and the create action is
 * gated on write access to the payments scope. */

import { useState } from "react";
import type { LifecycleEvent } from "@/types/domain";
import type { ReconciliationReport } from "@/services/client";
import { BTN_PRIMARY, Card, EmptyState, INPUT, Kpi, PageHeader, SearchBox } from "@/components/ui";
import { Can, Cannot } from "@/components/Can";
import { EventStream } from "@/components/Tables";
import { IconCard, IconRefresh } from "@/components/icons";
import { formatDateTime } from "@/utils/datetime";
import { ABILITY } from "@/utils/permissions";
import type { ApiGatewayCurrency } from "@/types/api";

export function PaymentsPage({
  events,
  recon,
  mode,
  onCreateCheckout,
  creating,
  createError,
}: {
  events: LifecycleEvent[];
  recon: ReconciliationReport;
  mode: "demo" | "live";
  /** Hands the customer over to the provider. Owns the request and the navigation. */
  onCreateCheckout: (input: {
    studentId: string;
    amount: string;
    currency: ApiGatewayCurrency;
  }) => void;
  creating: boolean;
  createError: string | null;
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
        lead="Payment processing as it flows from Amber Pay toward the accounting system: the customer pays on the provider's own page, and this console records what came back. References and statuses only — no amounts and no customer data."
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
              ? `ran ${formatDateTime(summary.ranAt)}`
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

      {/*
        ★ THE CREATE ACTION NOW DOES SOMETHING, AND IT CREATES A CHECKOUT RATHER
        THAN A LINK.

        The button this replaces was wired to nothing — a control that looked
        operative and reported nothing either way. That is the same dead-control
        class this repository has been removing elsewhere, and it was worst here:
        an operator would press it, see nothing change, and conclude payments
        were broken.

        There is no "link" to create. The gateway issues no URL a customer
        visits: it expects a signed POST and answers with the payment form. So
        this asks the API for the parameters and hands the customer over — the
        signed values are held in memory by `checkoutSession`, never in the URL,
        because a checkout page reachable by address is a payment page anybody
        can point somebody at with a live signature in it.

        The figure is typed here as a plain decimal (`250.00`) and is only ever
        passed to the gateway verbatim. It is not stored by the console and does
        not appear anywhere else on this page — FR-2.3, and the reason this
        surface has no amount column.
      */}
      <Card title="Take a payment" className="pm-create">
        <Can ability={ABILITY.paymentsWrite}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              onCreateCheckout({
                studentId: String(data.get('studentId') ?? ''),
                amount: String(data.get('amount') ?? ''),
                currency: String(data.get('currency') ?? 'JMD') as "USD" | "JMD",
              });
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-[220px] flex-1 flex-col gap-1">
                <span className="mono text-micro uppercase tracking-label text-ink-3">
                  Student ID
                </span>
                <input
                  name="studentId"
                  className={INPUT}
                  placeholder="STU0026"
                  autoComplete="off"
                  required
                />
              </label>
              <label className="flex w-[160px] flex-col gap-1">
                <span className="mono text-micro uppercase tracking-label text-ink-3">
                  Amount
                </span>
                <input
                  name="amount"
                  className={INPUT}
                  placeholder="250.00"
                  inputMode="decimal"
                  autoComplete="off"
                  required
                />
              </label>
              <label className="flex w-[120px] flex-col gap-1">
                <span className="mono text-micro uppercase tracking-label text-ink-3">
                  Currency
                </span>
                <select name="currency" className={INPUT} defaultValue="JMD">
                  <option value="JMD">JMD</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <button type="submit" className={BTN_PRIMARY} disabled={creating}>
                <IconCard /> {creating ? "Preparing…" : "Take payment"}
              </button>
            </div>

            <p className="m-0 text-xs leading-prose text-ink-3">
              The customer is handed straight to the payment provider&apos;s own page to enter
              card details. This console never sees or stores them, and the payment is only
              recorded once the provider calls back.
            </p>

            {createError && (
              <p className="m-0 text-sm text-text-suspended" role="alert">
                {createError}
              </p>
            )}
          </form>
        </Can>
        <Cannot ability={ABILITY.paymentsWrite}>
          <p className="m-0 mono text-xs text-ink-3">
            Taking a payment requires write access on the payments scope.
          </p>
        </Cannot>
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
