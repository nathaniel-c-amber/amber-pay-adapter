import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlert, IconBell, IconClock, IconLink, IconPolicy, IconSync } from "./icons";
import { EventStream, FindingsTable } from "./table/Tables";
import { NetworkMap } from "./diagram/NetworkMap";
import { STATUS_LABEL, openCount, suspendedCount } from "./data";
import type { PolicyScope } from "./data";
import { getToken, clearToken } from "../api/auth";
import { acknowledgeFailure, getMetrics, UnauthorizedError } from "../api/client";
import { mapMetrics } from "../api/map";
import type { MappedMetrics } from "../api/map";
import { LoginGate } from "../api/LoginGate";

function LampStatus({ status }: { status: "open" | "arriving" | "delayed" | "suspended" }) {
  return <span className={`status-tag ${status}`}><span className="mark" aria-hidden />{STATUS_LABEL[status]}</span>;
}

/** Format an ISO timestamp as "HH:MM" (the existing "14:58" style). */
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const POLL_MS = 15000;

export default function Dashboard() {
  const [token, setToken] = useState<string | null>(() => getToken());
  const [data, setData] = useState<MappedMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>("push");
  const [policy, setPolicy] = useState<PolicyScope | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  // Guards against stacked fetches when a poll overlaps an in-flight request (m3).
  const inFlightRef = useRef(false);

  const load = useCallback(async (t: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const m = await getMetrics(t);
      setData(mapMetrics(m));
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        clearToken();
        setToken(null);
      } else {
        setError(e instanceof Error ? e.message : "Failed to load metrics");
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  // Fetch on mount and poll while authenticated.
  useEffect(() => {
    if (!token) return;
    void load(token);
    const id = setInterval(() => void load(token), POLL_MS);
    return () => clearInterval(id);
  }, [token, load]);

  // Keep the active policy scope in sync with live policies.
  useEffect(() => {
    if (!data) return;
    setPolicy((prev) => {
      if (prev && data.policies.some((p) => p.id === prev.id)) return prev;
      return data.policies[0] ?? null;
    });
  }, [data]);

  const handleAuthenticated = (t: string) => setToken(t);

  if (!token) {
    return <LoginGate onAuthenticated={handleAuthenticated} />;
  }

  if (!data && loading) {
    return (
      <div className="monitor-shell">
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", color: "var(--porcelain-dim)" }}>
          Loading…
        </div>
      </div>
    );
  }

  if (!data && error) {
    return (
      <div className="monitor-shell">
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", color: "var(--text-suspended)" }}>
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="monitor-shell">
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", color: "var(--porcelain-dim)" }}>
          Loading…
        </div>
      </div>
    );
  }

  const { connectors, events, failures, policies, generatedAt } = data;
  const activePolicy = policy ?? policies[0] ?? null;

  const activeFailures = failures.filter((f) => !acked.has(f.id));
  const criticalOpen = activeFailures.filter((f) => f.severity === "critical").length;
  const oCount = openCount(connectors);
  const sCount = suspendedCount(connectors);
  const allOpen = sCount === 0;
  const asOf = formatClock(generatedAt);

  const ackFinding = async (id: string) => {
    if (!token) return;
    setAckError(null);
    try {
      await acknowledgeFailure(token, id);
      setAcked(new Set(acked).add(id));
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        clearToken();
        setToken(null);
      } else {
        setAckError(e instanceof Error ? e.message : "Failed to acknowledge");
      }
    }
  };
  const canAck = !activePolicy?.readOnly;

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
              As of <b>{asOf}</b> · <b>14:45</b> last pull
            </span>
            <label className="policy-scope">
              <IconPolicy aria-hidden />
              <span className="policy-scope-label">Scope</span>
              <select
                name="policy-scope"
                value={activePolicy?.id ?? ""}
                onChange={(e) => setPolicy(policies.find((p) => p.id === e.target.value) ?? policies[0] ?? null)}
                aria-label="Active policy scope"
              >
                {policies.map((p) => (
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
            {connectors.map((c) => (
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

          <NetworkMap connectors={connectors} activeId={activeId} onFocus={setActiveId} />

          <div className="lifecycle-strip">
            <h3>Lifecycle event stream</h3>
            <p className="caption">Only operational lifecycle events — no financial or customer data (FR-5.1, FR-5.2).</p>
            <EventStream events={events} />
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

          <div className="policy-banner" data-readonly={activePolicy?.readOnly}>
            <IconPolicy aria-hidden /> {activePolicy?.readOnly
              ? `Read-only: ${activePolicy.label} may inspect but not acknowledge.`
              : `${activePolicy?.label}: can acknowledge and act within scope.`}
          </div>

          {ackError && (
            <div style={{ color: "var(--text-suspended)", fontSize: "0.76rem", marginTop: "0.6rem" }} role="alert">
              {ackError}
            </div>
          )}

          <FindingsTable findings={activeFailures} canAck={canAck} onAck={ackFinding} />
        </aside>
      </div>
    </div>
  );
}