import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconActivity,
  IconAlert,
  IconBell,
  IconCard,
  IconCheck,
  IconClock,
  IconLatency,
  IconLink,
  IconLogout,
  IconRefresh,
  IconSettings,
  IconSync,
  IconUser,
  IconUsers,
} from "./icons";
import type { PolicyScope } from "@/types/domain";
import { getToken, clearToken } from "@/services/auth.service";
import {
  acknowledgeFailure,
  checkHealth,
  getCurrentUser,
  getMetrics,
  getReconciliationReport,
  getServiceStatus,
  UnauthorizedError,
} from "@/services/client";
import type { ReconciliationReport } from "@/services/client";
import type { ApiIdentity, ApiServiceStatus, ApiStageFlowSummary } from "@/types/api";
import { mapMetrics } from "@/services/map.service";
import type { MappedMetrics } from "@/services/map.service";
import { compareFlows } from "@/utils/flow";
import type { FlowComparison } from "@/utils/flow";
import { accessFor, isBroadest } from "@/utils/permissions";
import type { PageId } from "@/utils/permissions";
import { navigate, useRoute } from "@/router";
import type { RouteName } from "@/router";
import { SignInPage } from "@/pages/auth/SignInPage";
import { InvitePage } from "@/pages/auth/InvitePage";
import { DeniedPage } from "@/pages/auth/DeniedPage";
import { ForgotPasswordPage } from "@/pages/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "@/pages/auth/ResetPasswordPage";
import { demoMetrics, DEMO_RECON, DEMO_POLICIES, DEMO_CONFIG, DEMO_WEBHOOK, demoService } from "@/utils/fixtures";
import { ErrorState, LoadingState, SearchBox, cx } from "./ui";
import { OverviewPage } from "@/pages/OverviewPage";
import { ConnectionsPage, ConnectionDetailPage } from "@/pages/ConnectionsPage";
import { FindingsPage, FindingDetailPage } from "@/pages/FindingsPage";
import { EventsPage } from "@/pages/EventsPage";
import { PaymentsPage } from "@/pages/PaymentsPage";
import { SynchronizationPage } from "@/pages/SynchronizationPage";
import { ReconciliationPage } from "@/pages/ReconciliationPage";
import { ConfigPage } from "@/pages/ConfigPage";
import { UsersPage } from "@/pages/UsersPage";
import { ProfilePage } from "@/pages/ProfilePage";

/*
  Refresh cadence, in ms, chosen by the operator.

  The right answer depends on what they are watching: 5s while chasing a
  connector that keeps flapping, 60s for a console left open on a wall display.
  The previous hard-coded 15s was a guess that suited neither, and it was not
  negotiable without a redeploy.

  This one control sets the rhythm for BOTH the data poll and the connectivity
  probe — "how often this console checks in" is one idea, and two independent
  intervals would be two things to reason about for no benefit.
*/
const REFRESH_INTERVALS = [5000, 10000, 30000, 60000] as const;
const DEFAULT_REFRESH_MS = 10000;
const REFRESH_KEY = "amber.refreshMs";

/**
 * Read the saved cadence, rejecting anything not on the menu.
 *
 * localStorage is shared with every other script on the origin and survives
 * across deploys, so an unrecognised value is treated as absent rather than
 * trusted — a stale or hostile entry must not be able to set an interval of, say,
 * 1ms and turn this console into a request flood.
 */
function readRefreshMs(): number {
  const raw = Number(localStorage.getItem(REFRESH_KEY));
  return (REFRESH_INTERVALS as readonly number[]).includes(raw) ? raw : DEFAULT_REFRESH_MS;
}

function formatInterval(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * How often the shell's clock advances. Ages and uptime are shown to the
 * second, but a one-second tick re-renders the whole shell for numbers nobody
 * reads that precisely; five seconds keeps "oldest 47m 12s" honest enough.
 */
const TICK_MS = 5000;

/**
 * Timeout for the liveness probe.
 *
 * Without one, a backend that accepts the connection and then never replies
 * leaves the indicator saying "Checking…" forever — the least useful of the
 * three states, because it looks like the console is working on it.
 */
const HEALTH_TIMEOUT_MS = 5000;

interface NavItem {
  id: PageId;
  label: string;
  group: string;
  icon: React.ReactNode;
}

const NAV: NavItem[] = [
  { id: "overview", label: "Overview", group: "Monitor", icon: <IconActivity /> },
  // IconLink (a routed connection), not IconSync: Synchronization already
  // owns the sync glyph, and two identical glyphs made them indistinguishable
  // in the icon-rail tier.
  { id: "connections", label: "Connections", group: "Monitor", icon: <IconLink /> },
  // IconAlert, not IconBell: the topbar notification control owns the bell.
  { id: "findings", label: "Findings", group: "Monitor", icon: <IconAlert /> },
  { id: "events", label: "Event log", group: "Monitor", icon: <IconClock /> },
  { id: "payments", label: "Payments", group: "Operations", icon: <IconCard /> },
  { id: "synchronization", label: "Synchronization", group: "Operations", icon: <IconSync /> },
  { id: "reconciliation", label: "Reconciliation", group: "Operations", icon: <IconCheck /> },
  { id: "users", label: "Users", group: "Administration", icon: <IconUsers /> },
  { id: "settings", label: "System configuration", group: "Administration", icon: <IconSettings /> },
  { id: "profile", label: "Profile", group: "Account", icon: <IconUser /> },
];

/*
  Groups rendered as a nav list. "Account" is deliberately absent: its only
  member (Profile) is drawn in the sidebar footer beside Sign out, where the
  account controls live. NAV keeps the entry so the header title and the
  first-visible-route fallback still resolve "profile" as a real destination.
*/
const GROUPS = ["Monitor", "Operations", "Administration"];

/*
  Nav items and the chrome around them have mutually exclusive treatments, built
  as whole strings rather than base-plus-override. Tailwind resolves
  same-property utilities by stylesheet order, NOT by class order — so layering
  `bg-sel-bg` on `bg-transparent`, or `font-semibold` on `font-medium`, would be
  a coin flip that happens to look right until the sheet is reordered.

  The rail tier (<=1024px) centres the items and drops their labels; the drawer
  tier (<=720px) is a full navigation surface and explicitly restores both,
  because an icon-only drawer would defeat its own purpose.
*/
const NAV_ITEM =
  "flex w-full cursor-pointer items-center gap-3 rounded-panel border-l-[3px] px-3 py-2 text-left text-md transition-colors max-2xl:justify-center max-2xl:px-0 max-md:justify-start max-md:px-3";
const NAV_ITEM_OFF =
  "border-l-transparent bg-transparent font-medium text-ink-2 hover:bg-midnight-3 hover:text-ink-1";
const NAV_ITEM_ON = "border-l-primary bg-sel-bg font-semibold text-ink-1";

const NAV_ICON = "grid flex-none place-items-center transition-colors max-2xl:w-[22px] max-md:w-auto";
const NAV_ICON_OFF = "text-secondary";
const NAV_ICON_ON = "text-primary";

/* 30px square control used by the menu button, the bell, and the avatar. */
const ICON_BTN =
  "cursor-pointer rounded-panel border border-rule-enamel bg-transparent text-ink-2 transition-colors hover:border-ink-4 hover:bg-midnight-3 hover:text-ink-1";

const TOPBAR_BTN =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-panel border border-rule-enamel bg-transparent px-2 py-1 text-sm font-medium text-ink-2 transition-colors hover:border-ink-4 hover:bg-midnight-3 hover:text-ink-1 [&_svg]:text-secondary";

/*
  Console surfaces are the ones a policy can grant or withhold. The router also
  carries unauthenticated routes (signin, invite), and those have no access
  answer — asking "may this user read the sign-in page?" is meaningless. So
  they're narrowed out here rather than forced into the access map.
*/
const CONSOLE_ROUTES: readonly PageId[] = [
  "overview",
  "connections",
  "findings",
  "events",
  "payments",
  "synchronization",
  "reconciliation",
  "users",
  "settings",
  "profile",
];

function isConsoleRoute(name: RouteName): name is PageId {
  return (CONSOLE_ROUTES as readonly string[]).includes(name);
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/*
  Identity, derived from the one field the product actually holds: the account
  email. There is no name column, and inventing a person from an address would
  be a fabrication — "ops.team@acme.com" is a mailbox, not a colleague. So the
  address is split only to produce a readable label and initials, and the address
  itself is always shown alongside so the label never has to be trusted.
*/
function emailParts(email: string): string[] {
  return (email.split("@")[0] ?? "").split(/[._-]+/).filter(Boolean);
}

function displayNameOf(email: string): string {
  const name = emailParts(email)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return name || email;
}

function initialsOf(email: string): string {
  const parts = emailParts(email);
  if (parts.length === 0) return "?";
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

function pickDefaultPolicy(policies: PolicyScope[]): PolicyScope | null {
  if (policies.length === 0) return null;
  return policies.find(isBroadest) ?? policies[0];
}

export default function Shell() {
  const route = useRoute();
  const [token, setToken] = useState<string | null>(() => getToken());
  const [mode, setMode] = useState<"demo" | "live">(token ? "live" : "demo");
  const [data, setData] = useState<MappedMetrics>(() => demoMetrics());
  const [recon, setRecon] = useState<ReconciliationReport>(() => ({ reconciliation: DEMO_RECON, generatedAt: new Date().toISOString() }));
  const [service, setService] = useState<ApiServiceStatus | null>(null);
  /*
    Flow comparison state.
    The snapshot is stored with the mode it came from, because comparing a live
    reading against the demo fixture it replaced would invent a delta out of
    nothing — the console would announce movement that never happened.
  */
  const [comparison, setComparison] = useState<FlowComparison | null>(null);
  const flowSnapshot = useRef<{ mode: "demo" | "live"; stages: ApiStageFlowSummary | null } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [liveError, setLiveError] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [ackNotice, setAckNotice] = useState<string | null>(null);
  /* Set when a request is rejected with 401, so the sign-in page can say the
     session ended rather than presenting a bare form with no explanation. */
  const [sessionExpired, setSessionExpired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // True until the first live metrics response lands, so the console can show
  // a real loading treatment instead of rendering fixture numbers as if they
  // were live data.
  const [awaitingLive, setAwaitingLive] = useState<boolean>(() => Boolean(getToken()));
  const [liveUnavailable, setLiveUnavailable] = useState(false);
  const [mapFocus, setMapFocus] = useState<string | null>(null);
  /*
    The signed-in identity (GET /auth/me). The token alone cannot say WHO is
    signed in — it carries a subject id — so the header and the profile page
    both need this one record. Held here rather than fetched per page so the
    header and the profile cannot disagree about who the user is.
  */
  const [identity, setIdentity] = useState<ApiIdentity | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /*
    A signed-out visitor lands on sign-in rather than on a console full of
    synthetic figures. Demo exploration is still available, but it is now a
    choice the user makes explicitly from the sign-in page — a monitoring tool
    must never present fabricated data by default.
  */
  const [guest, setGuest] = useState(false);
  /*
    Refresh cadence, held in state and mirrored to localStorage so a reload keeps
    the operator's choice. Validated on read (see `readRefreshMs`).
  */
  const [refreshMs, setRefreshMs] = useState<number>(() => readRefreshMs());
  /*
    Backend reachability. `null` means "not measured yet", which is a different
    claim from "offline" — the indicator must not accuse the backend of being
    down before it has asked.
  */
  const [online, setOnline] = useState<boolean | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const inFlight = useRef(false);


  const policies = data.policies.length > 0 ? data.policies : DEMO_POLICIES;
  const [activePolicy, setActivePolicy] = useState<PolicyScope | null>(() =>
    pickDefaultPolicy(data.policies.length > 0 ? data.policies : DEMO_POLICIES),
  );

  // Keep active scope in sync whenever the policy set changes (live reload,
  // demo swap). Preserve the user's choice across reloads where possible.
  useEffect(() => {
    setActivePolicy((prev) => {
      if (prev && policies.some((p) => p.id === prev.id)) return prev;
      return pickDefaultPolicy(policies);
    });
  }, [data, mode, policies]);

  const applyLive = useCallback((m: MappedMetrics) => {
    setData(m);
    setMode("live");
    setLiveError(null);
  }, []);

  const applyDemo = useCallback(() => {
    setData(demoMetrics());
    setMode("demo");
    setLiveError(null);
  }, []);

  /*
    End the session from wherever it turned out to be dead. Declared here, above
    its callers, so every 401 path shares one definition — and stable, because
    pages take this callback as a prop and put it in a fetch effect's
    dependencies: an inline lambda would hand them a new function on every
    render, and a fresh fetch with it.
  */
  const requireSignIn = useCallback(() => {
    clearToken();
    setToken(null);
    setIdentity(null);
    setSessionExpired(true);
    setSidebarOpen(false);
    navigate("signin");
  }, []);

  /*
    Load (or reload) the signed-in identity. A 401 here is authoritative — the
    same token cannot be good for one endpoint and bad for another — so it ends
    the session exactly as a failed metrics call does. Any other failure just
    leaves the header without a name; the console stays usable.
  */
  const refreshIdentity = useCallback(
    async (t: string) => {
      try {
        setIdentity(await getCurrentUser(t));
      } catch (err) {
        setIdentity(null);
        if (err instanceof UnauthorizedError) requireSignIn();
      }
    },
    [requireSignIn],
  );

  useEffect(() => {
    if (token) void refreshIdentity(token);
    else setIdentity(null);
  }, [token, refreshIdentity]);

  /*
    Probe the backend, and keep probing on the chosen cadence.

    Guarded by an AbortController with a timeout: a request that hangs must
    resolve to "offline", not leave the indicator stuck on "Checking…". The
    controller is also aborted on cleanup, so a cadence change cannot leave the
    previous timer's in-flight probe to land on top of the new one's result.
  */
  const probeHealth = useCallback(async (signal?: AbortSignal) => {
    const result = await checkHealth(signal);
    if (signal?.aborted) return;
    setOnline(result.online);
    setLatencyMs(result.latencyMs);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    void probeHealth(controller.signal);
    const id = setInterval(() => void probeHealth(), refreshMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
      clearInterval(id);
    };
    // An interval callback gets no signal of its own, so only the first probe is
    // cancellable; the timer above exists for that one.
  }, [probeHealth, refreshMs]);

  const chooseRefreshMs = useCallback((ms: number) => {
    if (!(REFRESH_INTERVALS as readonly number[]).includes(ms)) return;
    setRefreshMs(ms);
    localStorage.setItem(REFRESH_KEY, String(ms));
  }, []);

  const loadLive = useCallback(
    async (t: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setRefreshing(true);
      try {
        const [m, r, svc] = await Promise.allSettled([
          getMetrics(t),
          getReconciliationReport(t).catch(() => null),
          getServiceStatus(t),
        ]);
        if (m.status === "fulfilled") {
          applyLive(mapMetrics(m.value));
          if (r.status === "fulfilled" && r.value) setRecon(r.value);
          setLiveUnavailable(false);
        } else if (m.reason instanceof UnauthorizedError) {
          /*
            A rejected token is not a reason to show invented numbers. The
            console used to fall back to demo fixtures here, which rendered
            fabricated figures under a "Demo data" tag in a window the user had
            opened expecting live monitoring — the worst possible failure mode
            for a monitoring tool. It now sends them to sign in, and says why.
          */
          clearToken();
          requireSignIn();
        } else {
          setLiveError(m.reason instanceof Error ? m.reason.message : "Live refresh failed");
          applyDemo();
          setLiveUnavailable(true);
        }
        /*
          The service probe is settled independently of the metrics call: the
          window's whole job is to report whether the backend is answering, so
          it must still render its "not responding" state when metrics fail.
        */
        if (svc.status === "fulfilled") setService(svc.value);
      } finally {
        inFlight.current = false;
        setRefreshing(false);
        setAwaitingLive(false);
      }
    },
    [applyLive, applyDemo, requireSignIn],
  );

  /*
    Refresh the flow comparison after every data or mode change, against the
    most recent snapshot from the SAME mode. Doing this in an effect (rather
    than inside loadLive) keeps it correct regardless of how the data arrived —
    poll, manual refresh, sign-in, or demo swap.
  */
  useEffect(() => {
    const next = data.stages ?? null;
    const prev = flowSnapshot.current;
    if (prev && prev.mode === mode && prev.stages && next) {
      setComparison(compareFlows(prev.stages, next));
    } else {
      setComparison(null);
    }
    flowSnapshot.current = { mode, stages: next };
  }, [data, mode]);

  // The shell clock: ages, dwell, and uptime all read from one ticking value so
  // two panels can never disagree about what "now" means.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Mount: load live if we have a token, otherwise demo.
  useEffect(() => {
    if (token) void loadLive(token);
    else applyDemo();
  }, [token, loadLive, applyDemo]);

  // Poll live metrics while authenticated and in live mode.
  useEffect(() => {
    if (!token || mode !== "live") return;
    const id = setInterval(() => void loadLive(token), refreshMs);
    return () => clearInterval(id);
  }, [token, mode, loadLive, refreshMs]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false);
  }, [route.path]);

  /*
    The sign-in surface is now a routed page, so focus management is its own
    problem: AuthShell moves focus to its heading on mount, and the browser
    handles history and Escape-to-leave for a page rather than a dialog. What
    remains here is clearing the expiry flag once a session is live again.
  */
  const handleAuthenticated = useCallback(
    (t: string) => {
      setToken(t);
      setSessionExpired(false);
      setActivePolicy(null);
      // Show the loading treatment rather than falling back to fixture data.
      setAwaitingLive(true);
      setLiveUnavailable(false);
      navigate("overview");
      void refreshIdentity(t);
      void loadLive(t);
    },
    [loadLive, refreshIdentity],
  );

  const handleSignOut = useCallback(() => {
    requireSignIn();
    setGuest(false);
    setSessionExpired(false);
    applyDemo();
  }, [applyDemo, requireSignIn]);

  const ackFinding = useCallback(
    async (id: string) => {
      setAckError(null);
      // Name the finding in the confirmation: "F-2074 acknowledged" alone
      // means nothing to a screen-reader user who never saw the card id.
      const label = data.failures.find((f) => f.id === id);
      const confirmation = `${label ? label.title : id} acknowledged.`;
      if (!token || mode !== "live") {
        // Demo: acknowledge locally so the flow is observable.
        setAcked((prev) => new Set(prev).add(id));
        setAckNotice(confirmation);
        return;
      }
      try {
        await acknowledgeFailure(token, id);
        setAcked((prev) => new Set(prev).add(id));
        setAckNotice(confirmation);
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          clearToken();
          requireSignIn();
          applyDemo();
        } else {
          setAckError(e instanceof Error ? e.message : "Failed to acknowledge");
        }
      }
    },
    [token, mode, applyDemo, data.failures, requireSignIn],
  );

  // The acknowledgement confirmation is announced politely and then cleared,
  // so a repeated acknowledgement of the same finding is announced again.
  useEffect(() => {
    if (!ackNotice) return;
    const id = setTimeout(() => setAckNotice(null), 6000);
    return () => clearTimeout(id);
  }, [ackNotice]);

  const access = accessFor(activePolicy);
  const activeFailures = useMemo(
    () => data.failures.filter((f) => !acked.has(f.id)),
    [data.failures, acked],
  );
  const criticalOpen = activeFailures.filter((f) => f.severity === "critical").length;
  /*
    The demo service status is built once per mode, not on every render: it
    derives its start time from Date.now(), so rebuilding it each render made
    the process appear to restart continuously and the uptime readout tick
    backwards.
  */
  const serviceForDisplay = useMemo(
    () => (mode === "live" ? service : demoService()),
    [mode, service],
  );
  const asOf = formatClock(data.generatedAt);
  const canAck = access.findings.canEdit;

  /*
    Authorization that is invisible is indistinguishable from authorization
    that is absent. A route the active scope cannot read used to be handled by
    silently redirecting to the first readable route, which from the user's side
    looks exactly like a broken link. The route is now rendered as a stated
    decision instead — see DeniedPage.
  */
  const denied =
    isConsoleRoute(route.name) && !access[route.name].visible ? route.name : null;

  const firstVisibleRoute = (): RouteName => {
    const first = NAV.find((n) => access[n.id].visible);
    return first ? first.id : "overview";
  };

  const activeNav = NAV.find((n) => n.id === route.name);

  const renderPage = () => {
    if (denied) {
      return (
        <DeniedPage
          label={NAV.find((n) => n.id === denied)?.label ?? "This surface"}
          scope={activePolicy}
          onBack={() => navigate(firstVisibleRoute())}
        />
      );
    }
    if (!isConsoleRoute(route.name)) return null;

    switch (route.name) {
      case "overview":
        return (
          <OverviewPage
            data={data}
            findings={activeFailures}
            canAck={canAck}
            onAck={ackFinding}
            ackError={ackError}
            now={now}
            comparison={comparison}
            service={serviceForDisplay}
            serviceUnavailable={mode === "live" && liveUnavailable}
          />
        );
      case "connections":
        return route.param ? (
          <ConnectionDetailPage
            connector={data.connectors.find((c) => c.id === route.param)}
            connectors={data.connectors}
            events={data.events}
            failures={activeFailures}
            activeId={mapFocus}
            onFocus={setMapFocus}
          />
        ) : (
          <ConnectionsPage
            connectors={data.connectors}
            events={data.events}
            activeId={mapFocus}
            onFocus={setMapFocus}
            mode={mode}
          />
        );
      case "findings":
        return route.param ? (
          <FindingDetailPage
            finding={activeFailures.find((f) => f.id === route.param)}
            connectors={data.connectors}
            events={data.events}
            canAck={canAck}
            onAck={ackFinding}
            ackError={ackError}
          />
        ) : (
          <FindingsPage
            findings={activeFailures}
            connectors={data.connectors}
            canAck={canAck}
            onAck={ackFinding}
            ackError={ackError}
            activePolicy={activePolicy}
          />
        );
      case "events":
        return <EventsPage events={data.events} mode={mode} stage={route.param} />;
      case "payments":
        return (
          <PaymentsPage
            events={data.events}
            recon={recon}
            canWrite={access.payments.canEdit}
            mode={mode}
          />
        );
      case "synchronization":
        return (
          <SynchronizationPage
            connectors={data.connectors}
            events={data.events}
            canWrite={access.payments.canEdit}
            onRefresh={() => (token ? void loadLive(token) : applyDemo())}
            syncing={refreshing}
          />
        );
      case "reconciliation":
        return <ReconciliationPage recon={recon} events={data.events} mode={mode} />;
      case "users":
        return (
          <UsersPage
            identity={identity}
            token={token}
            canEdit={access.users.canEdit}
            mode={mode}
            onRequireSignIn={requireSignIn}
          />
        );
      case "settings":
        return (
          <ConfigPage
            configs={DEMO_CONFIG}
            webhook={DEMO_WEBHOOK}
            canEdit={access.settings.canEdit}
            mode={mode}
          />
        );
      case "profile":
        return (
          <ProfilePage
            identity={identity}
            policies={policies}
            activePolicy={activePolicy}
            mode={mode}
            now={now}
            onSignOut={handleSignOut}
            onManageUsers={() => navigate("users")}
          />
        );
      default:
        return null;
    }
  };

  /*
    Unauthenticated surfaces render outside the console chrome entirely: no
    sidebar, no scope switcher, no data-provenance chip. A sign-in page framed
    by the navigation it is gating reads as a modal pretending to be a page.
  */
  if (route.name === "invite") {
    return (
      <InvitePage
        token={route.param}
        onGoToSignIn={() => navigate("signin")}
        onCancel={token ? () => navigate("overview") : undefined}
      />
    );
  }

  /*
    Credential recovery renders outside the shell for the same reason sign-in
    does: it is reachable with no session at all, so framing it with the
    navigation it is unlocking would be nonsense. Both are also reachable while
    signed in — a user who wants to rotate a password should not have to sign
    out first.
  */
  if (route.name === "forgot") {
    return (
      <ForgotPasswordPage
        onGoToSignIn={() => navigate("signin")}
        onUseResetLink={(resetToken) => navigate("reset", resetToken)}
      />
    );
  }

  if (route.name === "reset") {
    return (
      <ResetPasswordPage
        token={route.param}
        onGoToSignIn={() => navigate("signin")}
        onRequestNewLink={() => navigate("forgot")}
      />
    );
  }

  // A signed-out visitor with no console behind them gets sign-in, not demo
  // figures. The URL is preserved so a deep link survives the round trip.
  if (route.name === "signin" || (!token && !guest && isConsoleRoute(route.name))) {
    return (
      <SignInPage
        onAuthenticated={handleAuthenticated}
        expired={sessionExpired}
        onForgotPassword={() => navigate("forgot")}
        /* Offered only when there is genuinely no session: a signed-in user
           should not be invited to browse synthetic data instead of their own. */
        onExploreDemo={
          token
            ? undefined
            : () => {
                setGuest(true);
                setSessionExpired(false);
                navigate(isConsoleRoute(route.name) ? route.name : "overview");
              }
        }
        /* With a session already in hand, sign-in is a detour, so it needs a way
           back. Without one the user would be stranded on the form. */
        onCancel={token ? () => navigate("overview") : undefined}
      />
    );
  }

  return (
    <div className="grid min-h-screen grid-cols-[260px_minmax(0,1fr)] bg-midnight max-2xl:grid-cols-[76px_minmax(0,1fr)] max-md:grid-cols-[minmax(0,1fr)]">
      <a
        className="absolute top-0 left-[-9999px] focus:left-0 focus:z-50 focus:bg-ink-1 focus:px-4 focus:py-2 focus:text-midnight"
        href="#amb-main"
      >
        Skip to main content
      </a>

      {/* Sidebar */}
      <aside
        className={cx(
          "rail-scroll sticky top-0 flex h-screen flex-col gap-4 overflow-y-auto border-r border-rule-enamel bg-midnight-2 p-4",
          "max-md:fixed max-md:left-0 max-md:top-0 max-md:z-40 max-md:w-[260px]",
          /* The closed drawer is meant to leave the tab order via `visibility`,
             not just an off-screen transform — otherwise the ~12 nav controls
             stay reachable while invisible.

             KNOWN LIMITATION, inherited verbatim from the legacy sheet and NOT
             introduced by the Tailwind conversion: the delayed visibility
             transition on the way out (`visibility 0s linear 0.22s`) never
             resolves in Chrome, so once the drawer has been opened and closed
             the panel keeps `visibility: visible` and its controls stay
             focusable. Measured: a synthetic element using the same declaration
             still reports `visible` after 700ms, while an undelayed change
             reports `hidden`. Preserved as-is because this conversion is a
             visual no-op; fixing it means dropping the delay (the slide-out
             then hides instantly) or adding `inert`/`aria-hidden` to the closed
             panel. */
          sidebarOpen
            ? "max-md:visible max-md:translate-x-0 max-md:[transition:transform_0.22s_ease-out,visibility_0s_linear_0s]"
            : "max-md:invisible max-md:-translate-x-full max-md:[transition:transform_0.22s_ease-out,visibility_0s_linear_0.22s]",
        )}
        aria-label="Primary"
      >
        <div className="flex items-center gap-3 px-1.5 pt-0.5 pb-3 max-2xl:justify-center max-2xl:px-0 max-md:justify-start max-md:px-1.5">
          <span
            className="grid size-8 flex-none place-items-center rounded-panel border border-rule-enamel bg-midnight-3 transition-colors hover:border-primary"
            aria-hidden
          >
            <span
              className="size-[11px] rounded-full bg-primary shadow-[0_0_0_2px_var(--color-primary-soft),0_0_10px_rgb(239_96_0/0.25)]"
              aria-hidden
            />
          </span>
          <div className="max-2xl:hidden max-md:block">
            <div className="text-base font-semibold leading-[1.1] tracking-tight text-ink-1">Amber Pay</div>
            <div className="text-xs text-ink-2 max-2xl:hidden max-md:block">Pay Operations</div>
          </div>
          <button
            type="button"
            className="ml-auto hidden size-[26px] flex-none cursor-pointer place-items-center rounded-panel border border-rule-enamel bg-transparent text-base leading-none text-ink-2 max-md:grid"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          >
            ×
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto" aria-label="Sections">
          {GROUPS.map((group) => {
            const items = NAV.filter(
              (n) => n.group === group && access[n.id].visible,
            );
            if (items.length === 0) return null;
            return (
              <div className="flex flex-col gap-1" key={group}>
                <div className="mono px-2 pt-1 pb-1.5 text-micro uppercase tracking-label text-ink-3 max-2xl:hidden max-md:block">
                  {group}
                </div>
                {items.map((n) => {
                  const active = n.id === route.name;
                  const canEdit = activePolicy && access[n.id].canEdit;
                  return (
                    <button
                      key={n.id}
                      type="button"
                      className={cx(NAV_ITEM, active ? NAV_ITEM_ON : NAV_ITEM_OFF)}
                      onClick={() => navigate(n.id as RouteName)}
                      aria-current={active ? "page" : undefined}
                      /*
                        The label span is display:none in the icon-rail tier, so
                        without an explicit name every nav button had an empty
                        accessible name between 721 and 1024px.
                      */
                      aria-label={n.label}
                      title={n.label}
                    >
                      <span className={cx(NAV_ICON, active ? NAV_ICON_ON : NAV_ICON_OFF)}>{n.icon}</span>
                      <span className="flex-1 max-2xl:hidden max-md:inline">{n.label}</span>
                      {canEdit && (
                        <span
                          className="mono whitespace-nowrap rounded-chip border border-[rgb(57_185_138/0.4)] px-1.5 py-0.5 text-micro uppercase tracking-label text-line-green max-2xl:hidden max-md:inline"
                          title="Editable under this scope"
                        >
                          edit
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/*
          Account + health footer.

          Always visible, in every tier. It used to be drawer-only, which was
          fine while the header owned the account controls; now that it holds
          them, hiding it between 721px and 1024px would leave the console with
          no way to reach the profile or sign out at exactly the widths where the
          header has the least room.

          The labels collapse in the icon-rail tier like the nav items, so each
          control carries an aria-label and a title.
        */}
        <div className="border-t border-rule-enamel pt-3">
          <div className="flex w-full items-center gap-3 px-1.5 pt-1.5 pb-2 max-2xl:justify-center max-2xl:px-0">
            <span
              className="flex-none size-8 rounded-full border border-rule-enamel bg-midnight-3 text-micro font-semibold text-ink-1"
              aria-hidden
            >
              <span className="grid size-full place-items-center">
                {identity ? initialsOf(identity.email) : "·"}
              </span>
            </span>
            <span className="flex min-w-0 flex-col max-2xl:hidden">
              <span className="truncate text-md font-semibold text-ink-1">
                {identity ? displayNameOf(identity.email) : token ? "Signed in" : "Guest session"}
              </span>
              <span className="mono truncate text-xs text-ink-3">
                {identity?.email ?? activePolicy?.label ?? "no scope"}
              </span>
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <button
              type="button"
              className={cx(NAV_ITEM, route.name === "profile" ? NAV_ITEM_ON : NAV_ITEM_OFF)}
              aria-current={route.name === "profile" ? "page" : undefined}
              aria-label="Profile"
              title="Profile"
              onClick={() => navigate("profile")}
            >
              <span className={cx(NAV_ICON, route.name === "profile" ? NAV_ICON_ON : NAV_ICON_OFF)}>
                <IconUser />
              </span>
              <span className="flex-1 max-2xl:hidden max-md:inline">Profile</span>
            </button>

            {token && (
              <button
                type="button"
                className={cx(NAV_ITEM, NAV_ITEM_OFF)}
                aria-label="Sign out"
                title="Sign out"
                onClick={handleSignOut}
              >
                <span className={cx(NAV_ICON, NAV_ICON_OFF)}>
                  <IconLogout />
                </span>
                <span className="flex-1 max-2xl:hidden max-md:inline">Sign out</span>
              </button>
            )}
          </div>

          <div className="mt-2 flex flex-col gap-2 max-2xl:items-center">
            {/*
              Data provenance lives here rather than in the header, where the chip
              would now read as a second, contradictory connection status. A
              monitoring console must never let synthetic figures pass for live
              ones, so the claim stays on screen at every width.

              Not `DemoTag`: that shared chip is sized for a roomy page header,
              and at the 76px icon rail the content box is only 44px — "Demo" at
              the default padding measures 46px and would spill past the edge.
              The tighter rail padding below is what keeps it inside.
            */}
            {mode === "demo" && (
              <span
                className="mono whitespace-nowrap rounded-chip border border-[rgb(230_161_42/0.5)] px-2 py-0.5 text-micro uppercase tracking-label text-line-amber max-2xl:px-1"
                title="Synthetic demonstration data — not live figures"
              >
                Demo
              </span>
            )}
            {/*
              Hidden at the icon rail: "3 findings" needs 90px against a 44px
              content box. Nothing is lost, because the header bell carries the
              same count at every width, with the full wording in its label.
            */}
            <div className="mono inline-flex items-center gap-2 rounded-chip bg-midnight-3 px-2 py-1.5 text-xs text-ink-2 max-2xl:hidden">
              <span
                className="size-2 rounded-full bg-line-green data-[tone=bad]:bg-state-suspended data-[tone=warn]:bg-state-delayed"
                aria-hidden
                data-tone={activeFailures.length === 0 ? "good" : criticalOpen > 0 ? "bad" : "warn"}
              />
              {activeFailures.length === 0
                ? "All clear"
                : `${activeFailures.length} finding${activeFailures.length === 1 ? "" : "s"}`}
            </div>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="grid min-w-0 grid-rows-[auto_minmax(0,1fr)]">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-rule-enamel bg-[rgb(17_24_39/0.85)] px-6 py-3 backdrop-blur-[12px] max-sm:px-4">
          <button
            type="button"
            className="group hidden cursor-pointer flex-col justify-center gap-1 rounded-panel border border-rule-enamel bg-transparent p-0 max-md:inline-flex max-md:size-[30px] max-md:flex-none"
            aria-label="Toggle navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <span className="mx-auto block h-[1.5px] w-[14px] bg-ink-2 group-hover:bg-ink-1" aria-hidden />
            <span className="mx-auto block h-[1.5px] w-[14px] bg-ink-2 group-hover:bg-ink-1" aria-hidden />
            <span className="mx-auto block h-[1.5px] w-[14px] bg-ink-2 group-hover:bg-ink-1" aria-hidden />
          </button>

          <div className="flex min-w-0 items-baseline gap-3 max-md:flex-[1_1_auto]">
            <h1 className="whitespace-nowrap text-xl font-semibold text-ink-1 max-2xl:hidden max-md:block max-md:truncate">
              {activeNav?.label ?? "Overview"}
            </h1>
          </div>

          <div className="min-w-0 max-w-[320px] flex-1 max-5xl:max-w-[200px] max-2xl:hidden">
            <SearchBox
              value={globalQuery}
              onChange={setGlobalQuery}
              placeholder="Search events, findings, connections"
              label="Global search"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 max-sm:gap-1.5">
            <span
              className="inline-flex items-center gap-1.5 text-sm text-ink-2 max-lg:hidden [&_svg]:text-secondary"
              title="Time the monitoring data was collected"
            >
              <IconClock />
              Last updated <b className="mono font-medium text-ink-1">{asOf}</b>
            </span>

            {/*
              How often the console checks in. A select rather than a segmented
              control: four options at four widths would dominate a bar whose job
              is to stay out of the way, and the current value is one glance.
            */}
            <label className="inline-flex items-center gap-2 text-sm text-ink-2 [&_svg]:text-secondary">
              <IconLatency />
              <span className="mono text-micro uppercase tracking-label text-ink-3 max-lg:hidden">
                Every
              </span>
              <select
                className="cursor-pointer rounded-panel border border-rule-enamel bg-midnight-3 px-2 py-1 font-sans text-sm text-ink-1 transition-colors hover:border-ink-4"
                value={refreshMs}
                onChange={(e) => chooseRefreshMs(Number(e.target.value))}
                aria-label="Refresh interval"
                title="How often this console polls the API and re-checks the connection"
              >
                {REFRESH_INTERVALS.map((ms) => (
                  <option key={ms} value={ms}>
                    {formatInterval(ms)}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className={TOPBAR_BTN}
              title="Refresh monitoring data"
              aria-label="Refresh monitoring data"
              onClick={() => {
                void probeHealth();
                if (token) void loadLive(token);
                else applyDemo();
              }}
              disabled={refreshing}
            >
              <IconRefresh />
              <span className="max-sm:hidden">{refreshing ? "Refreshing" : "Refresh"}</span>
            </button>

            {/*
              Connection status, not data provenance. The two are different
              questions — "can this console reach the API?" versus "is what it is
              showing real?" — and the old chip answered the second while sitting
              where the first was expected. Provenance is now stated in the
              sidebar footer, where it cannot be mistaken for connectivity, and
              the offline case is still spelled out in full by the banner in
              `main`.

              The word carries the state, with shape as a second channel (solid
              when online, hollow outline otherwise) so the reading never depends
              on colour alone.
            */}
            <span
              className={cx(
                "mono inline-flex items-center gap-1.5 whitespace-nowrap rounded-chip border px-2 py-0.5 text-micro uppercase tracking-label",
                online === null
                  ? "border-rule-enamel text-ink-3"
                  : online
                    ? "border-[rgb(57_185_138/0.45)] text-line-green"
                    : "border-[rgb(248_113_113/0.5)] text-text-suspended",
              )}
              title={
                online === null
                  ? "Checking whether the API is reachable"
                  : online
                    ? `API reachable${latencyMs !== null ? ` — ${latencyMs}ms round trip` : ""}`
                    : "The API did not answer. Data shown may be stale or synthetic."
              }
            >
              <span
                className={cx(
                  "size-[7px] rounded-[1px]",
                  online ? "bg-line-green" : "border border-current bg-transparent",
                )}
                aria-hidden
              />
              {online === null ? "Checking" : online ? "Online" : "Offline"}
            </span>

            <button
              type="button"
              className={cx("relative inline-grid place-items-center", ICON_BTN, "size-[30px]")}
              aria-label={
                activeFailures.length === 0
                  ? "No open findings"
                  : `${activeFailures.length} open finding${activeFailures.length === 1 ? "" : "s"}`
              }
              onClick={() => navigate("findings")}
            >
              <IconBell />
              {activeFailures.length > 0 && (
                <span
                  className="mono absolute -top-1.5 -right-1.5 grid h-4 min-w-4 place-items-center rounded-[8px] border border-rule-enamel bg-midnight-raised px-1 text-micro font-semibold leading-none text-ink-1 data-[critical=true]:border-transparent data-[critical=true]:bg-state-suspended data-[critical=true]:text-[rgb(42_11_11)]"
                  data-critical={criticalOpen > 0 || undefined}
                >
                  {activeFailures.length}
                </span>
              )}
            </button>

            {/*
              The header keeps exactly one account control, and only for a guest:
              "Sign in". Profile and Sign out moved to the sidebar footer, where
              there is room for the account's name and address and where they sit
              with the rest of the navigation instead of competing with the
              monitoring controls for a slot in a bar that polls every few
              seconds. The identity chip that used to live here was also the
              only place the signed-in account was named — that job now belongs
              to the footer, which is visible at every width.
            */}
            {!token && (
              <button
                type="button"
                className={TOPBAR_BTN}
                aria-label="Sign in"
                title="Sign in"
                onClick={() => navigate("signin")}
              >
                <IconUser />
                <span className="max-sm:hidden">Sign in</span>
              </button>
            )}
          </div>
        </header>

        <main id="amb-main" className="min-w-0 px-6 pt-5 pb-10 max-sm:px-4 max-sm:pt-4 max-sm:pb-8">
          {/*
            A single polite live region owns every acknowledgement announcement
            and the tabular-data freshness stamp. Before this, a console that
            polls every 15s had no live region at all, so assistive tech never
            learned that anything had changed.
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {ackNotice ?? `Monitoring data last updated ${asOf}.`}
          </p>

          {awaitingLive && !liveUnavailable ? (
            <LoadingState label="Loading live monitoring data…" />
          ) : (
            <>
              {liveUnavailable && (
                <ErrorState
                  title="Live monitoring data is unavailable"
                  lead={`${liveError ? `${liveError}. ` : ""}Showing synthetic demo data so the console stays usable — do not read these figures as live.`}
                  retryLabel="Retry live data"
                  onRetry={() => (token ? void loadLive(token) : navigate("signin"))}
                />
              )}
              {renderPage()}
            </>
          )}
        </main>
      </div>

      {sidebarOpen && (
        <button
          type="button"
          className="hidden cursor-pointer border-none bg-[rgb(4_7_16/0.6)] max-md:fixed max-md:inset-0 max-md:z-30 max-md:block"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
}