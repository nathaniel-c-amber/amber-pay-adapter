import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconActivity,
  IconAlert,
  IconBell,
  IconCard,
  IconCheck,
  IconClock,
  IconLatency,
  IconLedger,
  IconLink,
  IconLogout,
  IconRefresh,
  IconSettings,
  IconSync,
  IconUser,
  IconUsers,
} from "./icons";
import type { Failure, PolicyScope } from "@/types/domain";
import { getToken, clearToken } from "@/services/auth.service";
import {
  acknowledgeFailures,
  checkHealth,
  completeTour,
  getCurrentUser,
  getMetrics,
  getReconciliationReport,
  getServiceStatus,
  getSettings,
  UnauthorizedError,
} from "@/services/client";
import type { ReconciliationReport } from "@/services/client";
import type {
  ApiIdentity,
  ApiServiceStatus,
  ApiStageFlowSummary,
  ApiCheckoutSession,
} from "@/types/api";
import { CheckoutHandoffPage } from "@/pages/CheckoutHandoffPage";
import { PaymentReturnPage } from "@/pages/PaymentReturnPage";
import { createCheckout } from "@/services/client";
import {
  clearPendingCheckout,
  setPendingCheckout,
  takePendingCheckout,
} from "@/services/checkoutSession";
import { mapFailure, mapMetrics } from "@/services/map.service";
import type { MappedMetrics } from "@/services/map.service";
import { compareFlows } from "@/utils/flow";
import { groupFindings } from "@/utils/findings";
import type { FlowComparison } from "@/utils/flow";
import { formatDateTimeSeconds } from "@/utils/datetime";
import { accessFor, isBroadest } from "@/utils/permissions";
import type { PageId } from "@/utils/permissions";
import { navigate, useRoute } from "@/router";
import type { RouteName } from "@/router";
import { TOUR_STEPS } from "@/tour/steps";
import { TourLayer } from "@/tour/TourLayer";
import { useAnchorRect } from "@/tour/useAnchorRect";
import { T_ANCHOR, anchorNeedsDrawer, navAnchor } from "@/tour/anchors";
import {
  firstShowable,
  nextShowable,
  prevShowable,
  showableCount,
  showablePosition,
} from "@/tour/engine";
import { PolicyProvider } from "./Can";
import { SignInPage } from "@/pages/auth/SignInPage";
import { InvitePage } from "@/pages/auth/InvitePage";
import { DeniedPage } from "@/pages/auth/DeniedPage";
import { ForgotPasswordPage } from "@/pages/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "@/pages/auth/ResetPasswordPage";
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage";
import { demoMetrics, DEMO_RECON, DEMO_POLICIES, demoService, DEMO_ENABLED } from "@/utils/fixtures";
import { ErrorState, LoadingState, SearchBox, cx, Card } from "./ui";
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
 * Titles for the routes that render outside the console shell.
 *
 * The console routes take their title from the nav entry, so this only has to
 * cover the unauthenticated surfaces — otherwise a user on an emailed invite
 * link sees a tab that still says "Amber Pay Ledger" and cannot tell the link
 * worked.
 */
const AUTH_TITLES: Partial<Record<RouteName, string>> = {
  signin: "Sign in",
  invite: "Accept invitation",
  forgot: "Reset your password",
  reset: "Choose a new password",
  onboarding: "Set up this deployment",
};

const APP_SUFFIX = "Amber Pay Ledger";

/**
 * The drawer's breakpoint, in JS as well as in CSS.
 *
 * `inert` is a DOM attribute, not a style, so it cannot be applied by a
 * Tailwind variant. The sidebar is a permanent column at >=720px and an
 * overlay drawer below it, which means the attribute has to be conditional on
 * the viewport — and this is the only place that can be expressed.
 */
const DRAWER_MEDIA_QUERY = "(max-width: 720px)";

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

/*
  What the console holds when there is no demo mode and live data has not
  arrived yet: nothing, stated as nothing.

  Every collection is empty and `generatedAt` is blank — the pages already
  render that as their "no data yet" empty state. This replaces a seed of
  synthetic metrics, which in a production build would have been reachable
  whenever a live refresh failed and would have put fabricated figures on screen
  under a live-mode label.
*/
const NO_DATA: MappedMetrics = {
  connectors: [],
  events: [],
  failures: [],
  policies: [],
  generatedAt: "",
};

const NO_RECON: ReconciliationReport = { reconciliation: null, generatedAt: "" };

/**
 * The checkout handoff, rendered from the ONE-SHOT session in `checkoutSession`.
 *
 * ★ WHY THIS IS ITS OWN COMPONENT.
 *
 * The session is consumed on read, which is what stops a back-button navigation
 * from replaying a signed payment page. But the shell re-renders constantly (a
 * clock tick, a poll), and reading the module state inline on every render would
 * consume it on the FIRST re-render and leave the customer looking at "Nothing to
 * pay" moments after the page appeared. So the read happens once, in a lazy
 * `useState` initializer, and the value is held for the lifetime of this mount.
 *
 * The `key` the caller sets on this component makes a RETRY work: a fresh
 * checkout is a new transaction id and a new single-use signature, and remounting
 * is what lets this component consume it — `navigate("checkout")` from the retry
 * is a no-op, because we never left the route.
 */
function CheckoutRoute({
  onCancelled,
  onRetry,
  retrying,
  errorText,
}: {
  onCancelled: () => void;
  onRetry: () => void;
  retrying: boolean;
  errorText: string | null;
}) {
  const [checkout] = useState<ApiCheckoutSession | null>(() => takePendingCheckout());
  if (!checkout) {
    return (
      <Card title="Nothing to pay">
        <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
          This payment link has already been used, or the page was opened directly. Start again
          from the message or link that brought you here.
        </p>
      </Card>
    );
  }
  return (
    <CheckoutHandoffPage
      checkout={checkout}
      onCancelled={onCancelled}
      onRetry={onRetry}
      retrying={retrying}
      errorText={errorText}
    />
  );
}

export default function Shell() {
  const route = useRoute();
  const [token, setToken] = useState<string | null>(() => getToken());
  /*
    Demo is a development-only mode (see DEMO_ENABLED in utils/fixtures.ts), so
    outside development the console starts in live and never leaves it: there is
    no synthetic figure anywhere below to fall back to.
  */
  const [mode, setMode] = useState<"demo" | "live">(() =>
    DEMO_ENABLED && !token ? "demo" : "live",
  );
  const [data, setData] = useState<MappedMetrics>(() =>
    DEMO_ENABLED ? demoMetrics() : NO_DATA,
  );
  const [recon, setRecon] = useState<ReconciliationReport>(() =>
    DEMO_ENABLED
      ? { reconciliation: DEMO_RECON, generatedAt: new Date().toISOString() }
      : NO_RECON,
  );
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
  const [ackNotice, setAckNotice] = useState<string | null>(null);
  /* True while an acknowledgement is in flight, so the actions that trigger one
     disable themselves rather than allowing a second click to race the first. */
  const [ackBusy, setAckBusy] = useState(false);
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
  /* The route announcement is kept separate from the connectivity one so that
     either can change without re-reading the other. */
  const [routeNotice, setRouteNotice] = useState("");
  /* True only while the viewport is narrow enough for the sidebar to be an
     overlay drawer rather than a permanent column. See DRAWER_MEDIA_QUERY. */
  const [drawerTier, setDrawerTier] = useState(false);

  /*
    First-run tour state. `tourIndex` is the position in TOUR_STEPS, or null when
    the tour is not running — ONE value rather than an {active, step} pair, so the
    two cannot disagree about whether the tour is up.
  */
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  /* Escape dismisses for this session only; "Skip tour" stamps permanently. */
  const [tourDismissed, setTourDismissed] = useState(false);
  const tourActive = tourIndex !== null;
  /*
    A ref, not the state value, for the two effects below that must fall silent
    while the tour runs. Adding `tourActive` to their dependency lists would re-run
    them on every start and finish, re-announcing the page and pulling focus back
    to `main` — the exact collision this exists to prevent. Assigned during render
    on purpose: it has to be current in the SAME commit that starts the tour,
    whereas an effect would lag a commit and let one announcement through.
  */
  const tourActiveRef = useRef(false);
  tourActiveRef.current = tourActive;
  /** The page container: the programmatic focus target on navigation. */
  const mainRef = useRef<HTMLElement>(null);
  /** Navigation announces itself, but the initial paint should not steal focus. */
  const skipFirstRouteEffect = useRef(true);


  const policies = data.policies.length > 0 ? data.policies : DEMO_ENABLED ? DEMO_POLICIES : [];
  const [activePolicy, setActivePolicy] = useState<PolicyScope | null>(() =>
    pickDefaultPolicy(data.policies.length > 0 ? data.policies : DEMO_ENABLED ? DEMO_POLICIES : []),
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
    /* No-op outside development: demo mode is a development affordance, not a
       fallback. Callers leave the console in live mode with whatever the API
       last returned. */
    if (!DEMO_ENABLED) return;
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

  // Track whether the sidebar is currently an overlay drawer (see
  // DRAWER_MEDIA_QUERY). Read once on mount and on every crossing.
  useEffect(() => {
    const mq = window.matchMedia(DRAWER_MEDIA_QUERY);
    const sync = () => setDrawerTier(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  /*
    Escape dismisses the open drawer. Without it the only exits are the backdrop
    and the close button, so a keyboard user who opened it by accident is stuck
    behind an overlay that covers the page.
  */
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The tour owns Escape while it is running. At the drawer tier a step
      // anchored on the navigation OPENS the drawer, so without this guard one
      // Escape would close the drawer and dismiss the tour together.
      if (event.key === "Escape" && !tourActiveRef.current) setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  /*
    Give every route its own document title, move focus into the view, and
    announce the destination.

    A hash-router navigation never reloads the document, so by default all
    thirteen routes shared one title and focus stayed on the nav control that
    had just been activated — a screen-reader user had to re-traverse the whole
    shell to find the new content (SC 2.4.2 and 2.4.3). Focus goes to `main`,
    which is a programmatic target (`tabIndex={-1}`) and so adds no tab stop.

    The focus move is deliberately skipped on the auth surfaces: `main` is not
    mounted there, they render their own shell, and AuthShell already focuses
    its own heading on mount.
  */
  /*
    Who gets the door rather than the room.

    ONE PREDICATE, TWO READERS — the document title in the effect below, and the
    render decision further down. They were written twice and promptly disagreed:
    the tab named one surface while the page showed another.

    It lives in the component BODY, not inside the effect, because the effect's
    callback cannot see what the render needs — and the render is what has to act on
    it. (The inverse trap is documented inside the effect: a value declared further
    down cannot be read by a callback above it.)

    `onboarding` is listed separately and ignores `guest`. A deployment cannot be
    configured without a session, since every write is authorized against the
    caller's policy, and a demo session has no deployment to configure — so it must
    not be able to reach a form that would write to one.
  */
  const needsSession =
    route.name === "signin" ||
    (route.name === "onboarding" && !token) ||
    (!token && !guest && isConsoleRoute(route.name));

  useEffect(() => {
    /*
      The title must name the surface actually RENDERED, not the route that was
      requested. A signed-out visitor deep-linking to #/overview sees the
      sign-in screen, so titling that page "Overview" would contradict the page
      in front of them — which is exactly what a title is for.

      Derived here, from primitives, rather than from the `activeNav`/`denied`
      values computed further down: those are consts declared later in the
      component body, and referencing them from a callback above their
      declaration is a temporal-dead-zone error at compile time.
    */
    const label = needsSession
      ? "Sign in"
      : (NAV.find((n) => n.id === route.name)?.label ?? AUTH_TITLES[route.name] ?? "Console");
    document.title = `${label} — ${APP_SUFFIX}`;

    if (skipFirstRouteEffect.current) {
      skipFirstRouteEffect.current = false;
      return;
    }
    /*
      While the tour runs it owns focus and announcement: it moves focus to its
      own panel on each step, and several steps navigate BETWEEN routes. Left
      unguarded, this effect steals that focus to `main` and interrupts the step
      with a "page loaded" announcement. The title above is still set — the page
      really has changed — and the tour's own focus move does the announcing.
    */
    if (tourActiveRef.current) return;
    // `main` only exists on the console surfaces; on the auth interstitials it
    // is absent, so this is a no-op rather than a focus move into nothing.
    if (!mainRef.current) return;
    mainRef.current.focus();
    setRouteNotice(`${label} page loaded.`);
  }, [route.path, route.name, token, guest]);

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

      /*
        A DEPLOYMENT THAT HAS NEVER BEEN SET UP OPENS ON SETUP, not on a console of
        empty panels.

        ONCE, AT SIGN-IN — deliberately not a route guard. A guard would bounce an
        operator back to the wizard every time they looked at the Overview, which
        makes "I'll finish this in a moment" impossible, and the console is not
        useless before setup: it is how somebody checks what a partially configured
        deployment is doing. The wizard stays reachable from System configuration for
        whenever they are ready.

        An operator whose deployment is already configured from its ENVIRONMENT sees
        this once and skips it, which records that setup is done. That is why the flow
        offers a skip rather than a hard wall: the environment is a legitimate source
        of configuration, and the deployment has no way to know it was used.
      */
      void (async () => {
        try {
          const loaded = await getSettings(t);
          if (!loaded.configured) navigate("onboarding");
        } catch {
          // Settings unreadable is not a reason to block the console: they can be
          // fixed from System configuration once it loads.
        }
      })();
    },
    [loadLive, refreshIdentity],
  );

  const handleSignOut = useCallback(() => {
    requireSignIn();
    setGuest(false);
    setSessionExpired(false);
    applyDemo();
  }, [applyDemo, requireSignIn]);

  /*
    Merge server-confirmed acknowledgements into the metrics snapshot.

    The rows come back FROM THE SERVER, so this is not optimism — it is the
    authoritative acknowledgement state, including which operator it was
    recorded against. Patching from the response is used in preference to
    calling `loadLive` afterwards because that function early-returns whenever a
    refresh is already in flight; had the acknowledgement raced a poll, the
    write would have succeeded and the screen would have kept showing the
    finding as open until the next tick, with no indication anything was wrong.
  */
  const mergeAcknowledged = useCallback((rows: readonly Failure[]) => {
    if (rows.length === 0) return;
    const byId = new Map(rows.map((row) => [row.id, row]));
    setData((prev) => ({
      ...prev,
      failures: prev.failures.map((failure) => byId.get(failure.id) ?? failure),
    }));
  }, []);

  /*
    Demo mode has no server to hold the acknowledgement, so it is stamped
    locally against the signed-in identity. `acknowledgedBy` is omitted rather
    than faked when there is no identity, so a demo row is honestly attributed
    to nobody — the same treatment a pre-migration row gets.
  */
  const stampLocally = useCallback(
    (ids: readonly string[]): Failure[] => {
      const at = new Date().toISOString();
      const stamped = data.failures
        .filter((failure) => ids.includes(failure.id))
        .map((failure) => ({
          ...failure,
          acknowledgedAt: at,
          ...(identity ? { acknowledgedBy: identity.email } : {}),
        }));
      return stamped;
    },
    [data.failures, identity],
  );

  /*
    Acknowledge ONE INCIDENT — every occurrence of it, which is one or more ids.

    It goes through the batch endpoint even for a single occurrence, so there is
    exactly one acknowledgement code path in the console. Two paths meant two
    places for the attribution, the busy flag, and the sign-out-on-401 handling
    to drift apart, and the single-id one is the one that would have rotted.

    The confirmation names the INCIDENT rather than an id, because that is what
    the operator acted on: an id alone means nothing to someone reading the
    announcement who never saw the card.
  */
  const ackIncident = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setAckError(null);
      const title = data.failures.find((f) => f.id === ids[0])?.title;
      const confirmation =
        ids.length === 1
          ? `${title ?? ids[0]} acknowledged.`
          : `${title ?? "Incident"} acknowledged (${ids.length} occurrences).`;
      if (!token || mode !== "live") {
        mergeAcknowledged(stampLocally(ids));
        setAckNotice(confirmation);
        return;
      }
      setAckBusy(true);
      try {
        const result = await acknowledgeFailures(token, ids);
        mergeAcknowledged(result.failures.map(mapFailure));
        setAckNotice(confirmation);
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          clearToken();
          requireSignIn();
          applyDemo();
        } else {
          setAckError(e instanceof Error ? e.message : "Failed to acknowledge");
        }
      } finally {
        setAckBusy(false);
      }
    },
    [token, mode, applyDemo, data.failures, requireSignIn, mergeAcknowledged, stampLocally],
  );

  /*
    Acknowledge every OPEN finding as one operator action.

    Only open findings are sent: re-acknowledging a finding somebody else
    already handled would overwrite their name with the current operator's and
    destroy the attribution this change exists to record. Acknowledged findings
    stay visible under the page's own toggle.
  */
  const ackAllFindings = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setAckError(null);
      const confirmation = `${ids.length} finding${ids.length === 1 ? "" : "s"} acknowledged.`;
      if (!token || mode !== "live") {
        mergeAcknowledged(stampLocally(ids));
        setAckNotice(confirmation);
        return;
      }
      setAckBusy(true);
      try {
        const result = await acknowledgeFailures(token, ids);
        mergeAcknowledged(result.failures.map(mapFailure));
        setAckNotice(
          result.acknowledged === ids.length
            ? confirmation
            : // The server acknowledges only what the caller may see. Say what
              // actually happened rather than claiming the queue cleared.
              `${result.acknowledged} of ${ids.length} findings acknowledged.`,
        );
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          clearToken();
          requireSignIn();
          applyDemo();
        } else {
          setAckError(e instanceof Error ? e.message : "Failed to acknowledge");
        }
      } finally {
        setAckBusy(false);
      }
    },
    [token, mode, applyDemo, requireSignIn, mergeAcknowledged, stampLocally],
  );

  // The acknowledgement confirmation is announced politely and then cleared,
  // so a repeated acknowledgement of the same finding is announced again.
  useEffect(() => {
    if (!ackNotice) return;
    const id = setTimeout(() => setAckNotice(null), 6000);
    return () => clearTimeout(id);
  }, [ackNotice]);

  const access = accessFor(activePolicy);
  /*
    "Open" is now derived from the SERVER's acknowledgement, not from a local
    set of ids this browser has touched.

    The local set was the defect: it reset on every page load and was never
    shared, so an acknowledgement made by one operator vanished from their own
    screen on refresh and had never applied to anybody else's. Reading
    `acknowledgedAt` off the row makes every operator — and every reload — see
    the same state, which is the behaviour an acknowledgement is supposed to
    have had all along.
  */
  const activeFailures = useMemo(
    () => data.failures.filter((f) => !f.acknowledgedAt),
    [data.failures],
  );
  const criticalOpen = activeFailures.filter((f) => f.severity === "critical").length;
  /*
    "Nothing is wrong" and "nothing was read" are different claims. When a live
    refresh has failed and there is no demo mode to stand in, the console holds
    no findings at all — so the bell and the sidebar chip say they do not know,
    instead of counting zero and reading as health.
  */
  const findingsKnown = !(liveUnavailable && !DEMO_ENABLED);
  /*
    The demo service status is built once per mode, not on every render: it
    derives its start time from Date.now(), so rebuilding it each render made
    the process appear to restart continuously and the uptime readout tick
    backwards.
  */
  const serviceForDisplay = useMemo(
    () => (DEMO_ENABLED && mode === "demo" ? demoService() : service),
    [mode, service],
  );
  const asOf = formatDateTimeSeconds(data.generatedAt);

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

  /*
    The connectivity announcement. Empty until the first probe lands: `online`
    is `null` while unmeasured, and announcing "Offline" before asking would be
    a claim the console has not earned.
  */
  const connectivityNotice =
    online === null
      ? ""
      : online
        ? "Backend reachable. Online."
        : "Backend unreachable. Offline.";

  /* ------------------------------------------------------- first-run tour */

  const activeStep = tourIndex === null ? null : (TOUR_STEPS[tourIndex] ?? null);
  const stepAnchor = activeStep?.anchor;
  const anchorState = useAnchorRect(stepAnchor, tourActive && activeStep !== null);

  const tourProgress = useMemo(
    () => ({
      // Counted among the steps THIS policy can see, so a restricted account is
      // never told it is on "3 of 8" when two of those can never be shown.
      total: showableCount(TOUR_STEPS, activePolicy),
      position: tourIndex === null ? 0 : showablePosition(TOUR_STEPS, tourIndex, activePolicy),
    }),
    [activePolicy, tourIndex],
  );

  /*
    Offer the tour once, to an account that has never seen it.

    Every condition below is a real state rather than a defensive extra:
      - `identity` is null between the token being read and /auth/me answering,
        and starting there would tour a half-built shell;
      - demo and guest sessions have no account, so there is nothing to stamp and
        nothing to own the claim;
      - the auth interstitials have no console to point at.
    The stamp is read from the ACCOUNT, so a second device does not re-tour the
    same person and a cleared browser cannot replay it forever.
  */
  useEffect(() => {
    if (tourActive || tourDismissed) return;
    if (!token || !identity) return;
    if (identity.tourCompletedAt !== null) return;
    if (guest || mode === "demo") return;
    if (!isConsoleRoute(route.name)) return;
    const first = firstShowable(TOUR_STEPS, 0, activePolicy);
    if (first === null) return;
    setTourIndex(first);
  }, [tourActive, tourDismissed, token, identity, guest, mode, route.name, activePolicy]);

  /*
    Follow the step's route. The tour crosses two routes deliberately: it has to
    show that the console is navigable rather than describe navigation from one
    page.
  */
  useEffect(() => {
    if (!activeStep) return;
    if (activeStep.route !== route.name) navigate(activeStep.route);
  }, [activeStep, route.name]);

  /*
    A navigation or account-footer anchor lives inside the sidebar, which at
    <=720px is a closed drawer. Open it for those steps and close it again on the
    step after — a drawer left open behind a later step would cover the page that
    step is describing. Desktop tiers are unaffected (`drawerTier` is false).
  */
  useEffect(() => {
    if (!tourActive) return;
    setSidebarOpen(drawerTier && anchorNeedsDrawer(stepAnchor ?? null));
  }, [tourActive, drawerTier, stepAnchor]);

  /*
    Skip a step whose anchor never appeared.

    This is what keeps the tour honest rather than merely working: the surface may
    be denied by policy, withheld because the backend never answered, or replaced
    by an empty state — and in every one of those the panel is advanced past
    instead of describing something the reader cannot see.
  */
  useEffect(() => {
    if (!tourActive || anchorState.status !== "absent") return;
    setTourIndex((current) =>
      current === null ? null : nextShowable(TOUR_STEPS, current, activePolicy),
    );
  }, [tourActive, anchorState.status, activePolicy]);

  /**
   * End the tour.
   *
   * `stamp` separates the two exits on purpose: finishing and "Skip tour" are
   * decisions not to be offered it again, whereas Escape is an accident that
   * should cost nothing.
   */
  const endTour = useCallback(
    (stamp: boolean) => {
      setTourIndex(null);
      if (!stamp) {
        setTourDismissed(true);
        return;
      }
      /*
        Optimistic locally, best-effort remotely. Stamping the local identity
        first closes the window in which the auto-start effect could fire again
        before the response lands. A failed write is swallowed deliberately: a
        tour that could not be RECORDED must not interrupt the tour or the
        session, and the worst outcome is one extra showing.
      */
      setIdentity((current) =>
        current ? { ...current, tourCompletedAt: new Date().toISOString() } : current,
      );
      if (token) void completeTour(token).catch(() => undefined);
    },
    [token],
  );

  const tourNext = useCallback(() => {
    if (tourIndex === null) return;
    const next = nextShowable(TOUR_STEPS, tourIndex, activePolicy);
    if (next === null) endTour(true);
    else setTourIndex(next);
  }, [tourIndex, activePolicy, endTour]);

  const tourBack = useCallback(() => {
    if (tourIndex === null) return;
    const previous = prevShowable(TOUR_STEPS, tourIndex, activePolicy);
    if (previous !== null) setTourIndex(previous);
  }, [tourIndex, activePolicy]);

  const tourDismiss = useCallback(() => endTour(false), [endTour]);
  const tourSkip = useCallback(() => endTour(true), [endTour]);

  /*
    Replay from Profile. Deliberately does NOT clear the stamp — a replay asks to
    see the tour now, not to be re-toured on every future sign-in.
  */
  const replayTour = useCallback(() => {
    setTourDismissed(false);
    const first = firstShowable(TOUR_STEPS, 0, activePolicy);
    if (first !== null) setTourIndex(first);
  }, [activePolicy]);

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
            onAck={ackIncident}
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
            /* The connector's findings are a LOG, not a to-do list: what
               happened to this connector, including what has since been seen. */
            failures={data.failures}
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
            /* Resolved against EVERY finding, not just the open ones: an
               acknowledged finding still has an incident page, and looking it
               up in the open set would make "View incident" on the
               Acknowledged tab land on a not-found page. */
            finding={data.failures.find((f) => f.id === route.param)}
            /* The whole INCIDENT, not just the occurrence the route names. The
               page is about one problem; handing it a single row is what made it
               show one timestamp for an incident reported sixteen times. */
            group={
              groupFindings(data.failures).find((g) =>
                g.members.some((member) => member.id === route.param),
              )
            }
            connectors={data.connectors}
            events={data.events}
            onAck={(ids: string[]) => ackIncident(ids)}
            ackBusy={ackBusy}
            ackError={ackError}
          />
        ) : (
          <FindingsPage
            findings={data.failures}
            connectors={data.connectors}
            onAck={ackIncident}
            onAckAll={ackAllFindings}
            ackBusy={ackBusy}
            ackError={ackError}
            activePolicy={activePolicy}
          />
        );
      case "events":
        return (
          <EventsPage
            events={data.events}
            connectors={data.connectors}
            mode={mode}
            stage={route.param}
          />
        );
      case "payments":
        return (
          <PaymentsPage
            events={data.events}
            recon={recon}
            mode={mode}
            creating={creatingCheckout}
            createError={checkoutError}
            onCreateCheckout={(input) => void startCheckout(input)}
          />
        );
      case "synchronization":
        return (
          <SynchronizationPage
            connectors={data.connectors}
            events={data.events}
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
            mode={mode}
            onRequireSignIn={requireSignIn}
          />
        );
      case "settings":
        return <ConfigPage token={token} mode={mode} onRequireSignIn={requireSignIn} />;
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
            onReplayTour={replayTour}
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
  if (route.name === "onboarding" && token) {
    /*
      Signed in, and still outside the console. The wizard needs the session (every
      write is authorized against the caller's policy) but not the console's
      furniture: navigation to surfaces that cannot yet show anything true, a scope
      switcher, a data-provenance chip, and a findings bell that would be counting
      nothing.

      WITH NO SESSION THIS BRANCH DOES NOT MATCH, and the visit falls through to the
      sign-in door below (`needsSession`). Returning nothing here instead would
      render a blank page, which is the one outcome worse than asking somebody to
      sign in.
    */
    return (
      <OnboardingPage
        token={token}
        onDone={() => navigate("overview")}
        onLeave={() => navigate("overview")}
      />
    );
  }

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
    TAKING A PAYMENT.

    The request is made HERE, in the shell, rather than in the page — because the
    signed parameters must survive the navigation to `#/checkout`. They are held
    in `checkoutSession` (module scope, consumed on read) and the browser then goes
    to the provider. Keeping the request in the page would mean handing signed
    values to a component that unmounts on navigate, which is exactly how a
    signature ends up in history.state or the URL.
  */
  const [creatingCheckout, setCreatingCheckout] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  /*
    Bumped every time a checkout is minted, so the handoff subtree REMOUNTS and
    consumes the new one-shot session. A retry mints a FRESH checkout (a new
    transaction id and a new single-use signature), and without the remount the
    page would keep rendering the first, already-burned session.
  */
  const [checkoutEpoch, setCheckoutEpoch] = useState(0);
  /*
    The last request, kept so a retry can mint a fresh checkout for the SAME
    customer and amount instead of replaying a spent signature. Held in a ref,
    not state: it is read only inside the retry handler and must not itself cause
    a render.
  */
  const lastCheckoutInput = useRef<{
    studentId: string;
    amount: string;
    currency: "USD" | "JMD";
  } | null>(null);

  const startCheckout = useCallback(
    async (input: { studentId: string; amount: string; currency: "USD" | "JMD" }) => {
      if (!token) return;
      lastCheckoutInput.current = input;
      setCreatingCheckout(true);
      setCheckoutError(null);
      try {
        const { checkout } = await createCheckout(token, {
          // An invoice reference is not something an operator types here: the
          // accounting invoice is found by matching the customer, which is what
          // the matching rule is configured for. This id is the local handle.
          invoiceId: input.studentId,
          studentId: input.studentId,
          amount: input.amount,
          currency: input.currency,
        });
        setPendingCheckout(checkout);
        setCheckoutEpoch((n) => n + 1);
        navigate("checkout");
      } catch (err) {
        setCheckoutError(
          err instanceof Error && err.message
            ? err.message
            : "The payment could not be prepared.",
        );
      } finally {
        setCreatingCheckout(false);
      }
    },
    [token],
  );

  /*
    THE PAYMENT SURFACES A CUSTOMER USES.

    Both render outside the console chrome and both are reachable with no
    session, because neither is for an operator: a parent paying a fee has no
    console account, and putting the navigation of a monitoring tool around them
    while they pay would frame the wrong product entirely.

    `checkout` is NOT reachable by URL. It renders a signed form built from a
    session held in memory by the caller, so there is no address it can be
    reloaded from or pointed at — a checkout page a third party could link to
    would be a payment page they control.

    `payment-return` IS reachable, because the gateway redirects there, and it
    correlates from the transaction reference in the query string rather than
    from anything the URL asserts about the outcome.
  */
  if (route.name === "checkout") {
    // The session lives in module state, not in the URL and not in this
    // component. A reload lands here with nothing to render, and the customer
    // is told so rather than shown a blank page or an empty form that would
    // post nowhere.
    //
    // `key={checkoutEpoch}` is what makes a RETRY work: a retry mints a fresh
    // checkout, stores it in the module state, and bumps the epoch so this
    // subtree remounts and consumes the new session.
    return (
      <CheckoutRoute
        key={checkoutEpoch}
        onCancelled={() => {
          clearPendingCheckout();
          navigate("payment-return");
        }}
        onRetry={() => {
          const input = lastCheckoutInput.current;
          if (input) void startCheckout(input);
        }}
        retrying={creatingCheckout}
        errorText={checkoutError}
      />
    );
  }

  if (route.name === "payment-return") {
    return (
      /* The page reads its own `?token=` from the hash and fetches the public,
         session-free status itself. This shell keeps only what it alone knows —
         whether there is a session — so the one button that leads to the console
         can say the right thing for whoever is looking at it. */
      <PaymentReturnPage
        signedIn={Boolean(token)}
        onGoToConsole={() => navigate(token ? "overview" : "signin")}
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
  if (needsSession) {
    return (
      <SignInPage
        onAuthenticated={handleAuthenticated}
        expired={sessionExpired}
        onForgotPassword={() => navigate("forgot")}
        /*
          Offered only when there is genuinely no session AND this is a
          development build. A signed-in user should not be invited to browse
          synthetic data instead of their own; a deployed console should not
          offer synthetic data at all.
        */
        onExploreDemo={
          DEMO_ENABLED && !token
            ? () => {
                setGuest(true);
                setSessionExpired(false);
                navigate(isConsoleRoute(route.name) ? route.name : "overview");
              }
            : undefined
        }
        /* With a session already in hand, sign-in is a detour, so it needs a way
           back. Without one the user would be stranded on the form. */
        onCancel={token ? () => navigate("overview") : undefined}
      />
    );
  }

  return (
    <div className="grid min-h-screen grid-cols-[260px_minmax(0,1fr)] bg-midnight max-2xl:grid-cols-[76px_minmax(0,1fr)] max-md:grid-cols-[minmax(0,1fr)]">
      {/*
        ONE inert wrapper around the entire console, so the tour can remove the
        page from the tab order and the accessibility tree in a single place.

        `contents` is load-bearing, not decoration: this element must not become a
        grid item or the two-column layout collapses to one. `display: contents`
        takes it out of the BOX tree while leaving its children as grid items, and
        `inert` still applies because inert works on the DOM tree, not the box
        tree. It sits inside the grid rather than around it so the tour layer can
        be a sibling of the inert subtree — an overlay rendered inside it would
        inert its own controls.
      */}
      <div className="contents" inert={tourActive}>
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
          /* The closed drawer is hidden with `visibility` AND made inert (see
             the `inert` attribute below). `visibility` alone was not enough:
             the delayed `visibility 0s linear 0.22s` on the way out never
             resolves in Chrome, so once the drawer had been opened and closed
             its ~12 nav controls stayed focusable while off-screen. `inert`
             removes the whole subtree from the tab order and the accessibility
             tree regardless of what the transition settles on, and it is
             applied only in the drawer tier — at desktop widths this is a
             permanent column and must stay interactive. */
          sidebarOpen
            ? "max-md:visible max-md:translate-x-0 max-md:[transition:transform_0.22s_ease-out,visibility_0s_linear_0s]"
            : "max-md:invisible max-md:-translate-x-full max-md:[transition:transform_0.22s_ease-out,visibility_0s_linear_0.22s]",
        )}
        aria-label="Primary"
        inert={drawerTier && !sidebarOpen}
      >
        <div className="flex items-center gap-3 px-1.5 pt-0.5 pb-3 max-2xl:justify-center max-2xl:px-0 max-md:justify-start max-md:px-1.5">
          <span
            className="grid size-8 flex-none place-items-center rounded-panel border border-rule-enamel bg-midnight-3 text-primary transition-colors hover:border-primary"
            aria-hidden
          >
            <IconLedger size={18} />
          </span>
          <div className="max-2xl:hidden max-md:block">
            <div className="text-base font-semibold leading-[1.1] tracking-tight text-ink-1">Amber Pay Ledger</div>
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
                      data-tour={navAnchor(n.id)}
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
        <div className="border-t border-rule-enamel pt-3" data-tour={T_ANCHOR.sidebarIdentity}>
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
                className={cx(
                  "size-2 rounded-full",
                  findingsKnown
                    ? "bg-line-green data-[tone=bad]:bg-state-suspended data-[tone=warn]:bg-state-delayed"
                    : /* Hollow, like the offline pill: shape carries "not known"
                         as well as the wording does. */
                      "border border-ink-3 bg-transparent",
                )}
                aria-hidden
                data-tone={activeFailures.length === 0 ? "good" : criticalOpen > 0 ? "bad" : "warn"}
              />
              {!findingsKnown
                ? "No live data"
                : activeFailures.length === 0
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
            {/*
              A label, not a document heading. This is the chrome's page title,
              and the page itself supplies the real `h1` via PageHeader — so
              making it an `h1` gave nine routes TWO top-level headings at
              <=720px (both visible at that width) and made the heading outline
              depend on the viewport. The heading hierarchy now comes from the
              content, once.
            */}
            <div className="whitespace-nowrap text-xl font-semibold text-ink-1 max-2xl:hidden max-md:block max-md:truncate">
              {activeNav?.label ?? "Overview"}
            </div>
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
                    : DEMO_ENABLED
                      ? "The API did not answer. Data shown may be stale or synthetic."
                      : "The API did not answer. Nothing is shown in place of it."
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
              data-tour={T_ANCHOR.findingsBell}
              className={cx(
                "relative inline-grid place-items-center",
                ICON_BTN,
                "size-[30px]",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
              aria-label={
                !findingsKnown
                  ? "Open findings unknown"
                  : activeFailures.length === 0
                    ? "No open findings"
                    : `${activeFailures.length} open finding${activeFailures.length === 1 ? "" : "s"}`
              }
              title={
                findingsKnown ? "Open findings" : "Live monitoring data is unavailable, so this count is unknown"
              }
              disabled={!findingsKnown}
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

        <main
          id="amb-main"
          ref={mainRef}
          tabIndex={-1}
          /*
            `wrap-anywhere` here is a SAFETY NET, and the per-surface fixes in
            FindingCard, FindingsPage and EventStream are the real ones.

            `overflow-wrap` is inherited, so this one declaration covers every
            console surface, including the auth-adjacent and detail views nobody
            thought to test with a pathological string. That matters because the
            offending content is not authored copy: it is `detail` off a server
            event, which routinely embeds the upstream request that failed, and a
            URL has no break opportunity in it.

            It cannot damage the mono readouts. Everything that must stay on one
            line — timestamps, badges, references — already sets
            `whitespace-nowrap`, and that beats an inherited wrap rule. Only text
            that would otherwise overflow is affected.
          */
          className="min-w-0 px-6 pt-5 pb-10 wrap-anywhere max-sm:px-4 max-sm:pt-4 max-sm:pb-8 focus:outline-none"
        >
          {/*
            A single polite live region owns every acknowledgement announcement
            and the tabular-data freshness stamp. Before this, a console that
            polls every 15s had no live region at all, so assistive tech never
            learned that anything had changed.
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {ackNotice ?? `Monitoring data last updated ${asOf}.`}
          </p>

          {/*
            Connectivity is the single most important thing this console
            reports, and it was carried only by the pill's visible text and its
            `title` — so "Offline" was silent to assistive tech (SC 4.1.3).
            Only a transition is announced: the pill itself is not a live
            region, so reading order still reports the current value on demand.
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {connectivityNotice}
          </p>

          <p className="sr-only" role="status" aria-live="polite">
            {routeNotice}
          </p>

          {awaitingLive && !liveUnavailable ? (
            <LoadingState label="Loading live monitoring data…" />
          ) : (
            <>
              {liveUnavailable && (
                <ErrorState
                  title="Live monitoring data is unavailable"
                  lead={
                    DEMO_ENABLED
                      ? `${liveError ? `${liveError}. ` : ""}Showing synthetic demo data so the console stays usable — do not read these figures as live.`
                      : `${liveError ? `${liveError}. ` : ""}No figures are shown in place of the ones that could not be read: this console reports live data only.`
                  }
                  retryLabel="Retry live data"
                  onRetry={() => (token ? void loadLive(token) : navigate("signin"))}
                />
              )}
              {/*
                The active policy is published to the rendered page, not just
                computed here: a button inside a card asks the same object the
                same question the nav asked, so a page and its controls cannot
                disagree about what the policy grants. Nothing threads a
                `canEdit` boolean down the tree any more.

                The page itself is withheld when live data is unavailable and
                there is no demo mode to fall back on: rendering it with empty
                collections would paint "All clear" and "0 findings" over a
                backend that never answered, which reads as health.
              */}
              {(!liveUnavailable || DEMO_ENABLED) && (
                <PolicyProvider policy={activePolicy}>{renderPage()}</PolicyProvider>
              )}
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

      {/*
        The layer is a SIBLING of the inert wrapper, never a child: rendered
        inside it, `inert` would make the tour's own controls unreachable.
      */}
      {tourActive && activeStep && (
        <TourLayer
          step={activeStep}
          position={tourProgress.position}
          total={tourProgress.total}
          anchor={anchorState}
          onNext={tourNext}
          onBack={tourBack}
          onSkip={tourSkip}
          onDismiss={tourDismiss}
        />
      )}
    </div>
  );
}