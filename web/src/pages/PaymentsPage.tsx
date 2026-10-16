/* Payments — the operational payment lifecycle.
 *
 * Shows the payment-processing side of the chain with reference hashes and
 * statuses only. There is deliberately no amount, currency, or customer
 * field anywhere on this surface (FR-2.3 / FR-5.2), and the create action is
 * gated on write access to the payments scope. */

import { useMemo, useState } from "react";
import type { LifecycleEvent } from "@/types/domain";
import type { ReconciliationReport } from "@/services/client";
import { BTN, BTN_PRIMARY, Card, EmptyState, INPUT, Kpi, PageHeader, SearchBox } from "@/components/ui";
import { Can, Cannot } from "@/components/Can";
import { EventStream } from "@/components/Tables";
import { FilterChips, toggleInSet } from "@/components/FilterChips";
import { IconCard, IconRefresh } from "@/components/icons";
import { formatDateTime } from "@/utils/datetime";
import { ABILITY } from "@/utils/permissions";
import {
  NO_FILTERS,
  PAYMENT_OUTCOMES,
  UNSETTLED_OUTCOMES,
  WINDOW_PRESETS,
  filterEvents,
  isUnfiltered,
  outcomeCounts,
} from "@/utils/eventFilters";
import type { EventFilters, PaymentOutcomeId, WindowPreset } from "@/utils/eventFilters";
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
  const [filters, setFilters] = useState<EventFilters>(NO_FILTERS);
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

  // Outcome and window narrow the payment list; search narrows that further.
  const windowed = filterEvents(paymentEvents, filters);
  const filtered = query
    ? windowed.filter(
        (e) =>
          e.detail.toLowerCase().includes(query.toLowerCase()) ||
          e.ref.toLowerCase().includes(query.toLowerCase()),
      )
    : windowed;

  const counts = outcomeCounts(paymentEvents);
  const active = !isUnfiltered(filters);

  /*
    The "Declined / failed" figure and the chip that reproduces it read from ONE
    source: `UNSETTLED_OUTCOMES`. Counting it here with its own expression is how
    the number and the filter start disagreeing, and then clicking the figure
    lands on a list of a different size than the figure promised.
  */
  const declined = useMemo(
    () => filterEvents(paymentEvents, { ...NO_FILTERS, outcomes: new Set(UNSETTLED_OUTCOMES) }).length,
    [paymentEvents],
  );

  const focusUnsettled = () => {
    const outcomes = new Set<string>(UNSETTLED_OUTCOMES);
    // Toggle: pressing the figure again returns to the unfiltered list, so it
    // behaves like the chips beside it rather than trapping the operator in a
    // filtered view they cannot leave from where they clicked.
    const alreadyOnlyUnsettled =
      filters.outcomes.size === outcomes.size &&
      [...outcomes].every((id) => filters.outcomes.has(id));
    setFilters((prev) => ({ ...prev, outcomes: alreadyOnlyUnsettled ? new Set() : outcomes }));
  };

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
          note={declined > 0 ? "click to filter" : "none in window"}
          tone={declined > 0 ? "warn" : "good"}
          icon={<IconCard />}
          onClick={focusUnsettled}
          pressed={filters.outcomes.size === UNSETTLED_OUTCOMES.length &&
            UNSETTLED_OUTCOMES.every((id) => filters.outcomes.has(id))}
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
        meta={<span className="mono">{filtered.length}{active ? ` of ${paymentEvents.length}` : ""} events · {mode === "demo" ? "synthetic" : "live"}</span>}
        className="pm-events"
      >
        {/*
          Outcome and window, in that order: which state a payment reached is the
          question, and when it happened is the qualification. Counts come from
          the unfiltered payment list so a chip keeps showing how much is behind
          it rather than collapsing to its own selection.
        */}
        <div className="mb-3 flex flex-col gap-2">
          <FilterChips<PaymentOutcomeId>
            label="Filter by payment outcome"
            options={PAYMENT_OUTCOMES.map((outcome) => ({
              id: outcome.id,
              label: outcome.label,
              count: counts[outcome.id] ?? 0,
            }))}
            selected={filters.outcomes as ReadonlySet<PaymentOutcomeId>}
            onToggle={(id) =>
              setFilters((prev) => ({ ...prev, outcomes: toggleInSet(prev.outcomes, id) }))
            }
          />
          <FilterChips<WindowPreset>
            label="Filter by time window"
            options={WINDOW_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }))}
            selected={
              filters.window.kind === "preset" ? new Set([filters.window.preset]) : new Set()
            }
            onToggle={(id) =>
              setFilters((prev) => ({ ...prev, window: { kind: "preset", preset: id } }))
            }
            trailing={
              active ? (
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 text-sm font-semibold text-ink-3 underline underline-offset-[0.18em] hover:text-ink-1"
                  onClick={() => setFilters(NO_FILTERS)}
                >
                  Clear filters
                </button>
              ) : undefined
            }
          />
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title={
              paymentEvents.length === 0
                ? "No payment events"
                : active
                  ? "No events match these filters"
                  : "No events match this search"
            }
            lead={
              paymentEvents.length === 0
                ? "Payment lifecycle events will appear here as payments are initiated and collected."
                : active
                  ? `The filters are narrowing ${paymentEvents.length} payment events to none. The window holds the newest events only, so a short time range can legitimately come back empty.`
                  : "Try a different reference or detail term."
            }
            action={
              active ? (
                <button type="button" className={BTN} onClick={() => setFilters(NO_FILTERS)}>
                  Clear filters
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
