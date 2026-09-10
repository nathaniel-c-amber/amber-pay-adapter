import { useState } from "react";
import { IconAlert, IconBell, IconClock, IconLink, IconPolicy, IconSync } from "./icons";
import { EventStream, FindingsTable } from "./table/Tables";
import { NetworkMap } from "./diagram/NetworkMap";
import {
  CONNECTORS,
  DEFAULT_POLICY,
  EVENTS,
  FAILURES,
  POLICIES,
  STATUS_LABEL,
  openCount,
  suspendedCount,
} from "./data";
import type { PolicyScope } from "./data";

function LampStatus({ status }: { status: "open" | "arriving" | "delayed" | "suspended" }) {
  return <span className={`status-tag ${status}`}><span className="mark" aria-hidden />{STATUS_LABEL[status]}</span>;
}

export default function Dashboard() {
  const [activeId, setActiveId] = useState<string | null>("push");  const [policy, setPolicy] = useState<PolicyScope>(DEFAULT_POLICY);
  const [acked, setAcked] = useState<Set<string>>(new Set());

  const activeFailures = FAILURES.filter((f) => !acked.has(f.id));
  const criticalOpen = activeFailures.filter((f) => f.severity === "critical").length;
  const oCount = openCount(CONNECTORS);
  const sCount = suspendedCount(CONNECTORS);
  const allOpen = sCount === 0;

  const ackFinding = (id: string) => setAcked(new Set(acked).add(id));
  const canAck = !policy.readOnly;

  return (
    <div className="monitor-shell">
      <a className="skip-link" href="#board">Skip to connector board</a>

      <header className="monitor-header">
        <div className="header-row">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              <span className="brand-mark-inner" aria-hidden />
            </span>
            <div>
              <div className="brand-name">Amber Pay</div>
              <div className="brand-sub">API Adaptor · Monitor</div>
            </div>
          </div>
          <div className="header-meta">
            <span className={`status-chip ${allOpen ? "good" : "bad"}`}>
              <span className="dot" aria-hidden />
              {allOpen
                ? `${oCount} lines open`
                : `${sCount} suspended · ${criticalOpen} critical`}
            </span>
            <span className="as-of">
              <IconClock />
              As of <b>14:58</b> · <b>14:45</b> last pull
            </span>
            <label className="policy-scope">
              <IconPolicy aria-hidden />
              <span className="policy-scope-label">Scope</span>
              <select
                name="policy-scope"
                value={policy.id}
                onChange={(e) => setPolicy(POLICIES.find((p) => p.id === e.target.value) ?? DEFAULT_POLICY)}
                aria-label="Active policy scope"
              >
                {POLICIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <h1>Connector Monitor</h1>
        <p className="header-sub">
          Every connector between Amber Pay and your accounting adaptors — open, delayed, or suspended, nothing slips past.
        </p>
      </header>

      <div className="monitor-body" role="region" aria-label="Connector instruments">
        {/* System rail */}
        <aside className="rail zone-rail" aria-label="Connector channels">
          <h2 className="visually-hidden">Channels</h2>
          <div className="channel-list">
            {CONNECTORS.map((c) => (
              <div className="channel" key={c.id}>
                <span className={`lamp lamp--${c.color}`} aria-hidden />
                <div className="channel-name">
                  {c.label}
                  <small>{c.note}</small>
                </div>
                <div className="channel-read mono">{c.reading}</div>
                <LampStatus status={c.status} />
              </div>
            ))}
          </div>
          <div className="rail-meta">
            <h3 id="channels-sec">Live channels</h3>
            <ul aria-label="Channel legend">
              <li><IconLink /> Push target: QuickBooks Online</li>
              <li><IconSync /> Scheduled pull: 15 min</li>
              <li><IconBell /> Alerts: on-call queue</li>
            </ul>
          </div>
        </aside>

        {/* Service map board */}
        <section className="board zone-board" id="board" aria-label="Connector board">
          <div className="board-head">
            <h2>Connector map</h2>
            <span className="lead-rule">Amber Pay ⇄ accounting adaptors · today</span>
          </div>
          <p className="board-intro">
            Focus a line to burn it bright and read its segment states. Suspended lines show a served hatch.
          </p>

          <NetworkMap connectors={CONNECTORS} activeId={activeId} onFocus={setActiveId} />

          <div className="lifecycle-strip">
            <h3>Lifecycle event stream</h3>
            <p className="caption">Only operational lifecycle events — no financial or customer data (FR-5.1, FR-5.2).</p>
            <EventStream events={EVENTS} />
          </div>
        </section>

        {/* Findings / failures */}
        <aside className="exceptions zone-exceptions" aria-label="Failures and findings">
          <div className="exceptions-head">
            <h2>Findings</h2>
            <span className="findings-count">{activeFailures.length}</span>
            <IconAlert aria-hidden className="exceptions-icon" />
          </div>
          <p className="exceptions-intro">
            Ranked by attention. Acknowledge to mark it with a tick — findings stay until dealt with.
          </p>

          <div className="policy-banner" data-readonly={policy.readOnly}>
            <IconPolicy aria-hidden /> {policy.readOnly
              ? `Read-only: ${policy.label} may inspect but not acknowledge.`
              : `${policy.label}: can acknowledge and act within scope.`}
          </div>

          <FindingsTable findings={activeFailures} canAck={canAck} onAck={ackFinding} />
        </aside>
      </div>
    </div>
  );
}
