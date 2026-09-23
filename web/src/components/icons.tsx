/**
 * Icon system.
 *
 * Backed by Lucide — one authored family on a 24-unit grid with consistent
 * terminals, joins and optical weight. The previous hand-drawn set had
 * inconsistent internal geometry (some marks were abstract to the point of
 * being unreadable at 16px, and two navigation items shared a glyph), which
 * reads as unfinished on an operations console someone stares at all day.
 *
 * Two deliberate choices:
 *  - `absoluteStrokeWidth` keeps the stroke a true 1.5px at every rendered
 *    size, so a 14px inline icon and a 20px nav icon carry the same weight
 *    instead of the small one looking heavier.
 *  - Icons are `aria-hidden` by default. Every icon here sits beside a text
 *    label; a control that navigates alone carries the aria-label itself,
 *    never the glyph.
 *
 * Export names from the previous set are preserved so consumers did not have
 * to change; the new names below cover the flow-stage model.
 */

import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BadgeCheck,
  Bell,
  BookText,
  Boxes,
  Cable,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Clock,
  CreditCard,
  Database,
  Gauge,
  House,
  Inbox,
  Info,
  KeyRound,
  LayoutGrid,
  LogOut,
  Minus,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCcw,
  RefreshCw,
  Route,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Timer,
  TrendingUp,
  TriangleAlert,
  User,
  Users,
  Waypoints,
  Workflow,
} from "lucide-react";

/** Shared icon props: lucide's, minus the ref. */
export type IconProps = Omit<LucideProps, "ref">;

const DEFAULT_SIZE = 16;
const DEFAULT_STROKE = 1.5;

/**
 * Wrap a Lucide glyph with the console's defaults: true-1.5px stroke at any
 * size, decorative unless told otherwise.
 */
function icon(Glyph: ComponentType<LucideProps>): ComponentType<IconProps> {
  const Wrapped = ({ size = DEFAULT_SIZE, ...rest }: IconProps) => (
    <Glyph
      size={size}
      strokeWidth={DEFAULT_STROKE}
      absoluteStrokeWidth
      aria-hidden
      focusable={false}
      {...rest}
    />
  );
  Wrapped.displayName = Glyph.displayName ?? Glyph.name ?? "Icon";
  return Wrapped;
}

/* -------------------------------------------------------------- brand */
/**
 * The product mark: an open accounting book.
 *
 * It replaces the abstract amber dot that used to fill the logo plates. A dot
 * said nothing about what this console is; the ledger names the thing the whole
 * product exists to keep reconciled. One glyph, so the console and the
 * unauthenticated surface cannot drift apart.
 */
export const IconLedger = icon(BookText);

/* ---------------------------------------------------------------- nav */
export const IconOverview = icon(Gauge);
export const IconConnections = icon(Cable);
export const IconFindings = icon(TriangleAlert);
export const IconEvents = icon(Clock);
export const IconPayments = icon(CreditCard);
export const IconSync = icon(RefreshCcw);
export const IconReconciliation = icon(CircleCheck);
export const IconUsers = icon(Users);
export const IconSettings = icon(Settings2);
export const IconProfile = icon(User);

/* ------------------------------------------------------ flow stages */
export const IconStageInitiated = icon(Send);
export const IconStageCollected = icon(CreditCard);
export const IconStageIngested = icon(Inbox);
export const IconStagePosted = icon(PackageCheck);
export const IconFlowArrow = icon(ChevronRight);
export const IconFlowRoute = icon(Route);

/* ------------------------------------------------------------ service */
export const IconService = icon(Server);
export const IconStorage = icon(Database);
export const IconLatency = icon(Timer);
export const IconUptime = icon(Activity);
export const IconAdaptor = icon(Boxes);
export const IconPipeline = icon(Workflow);
export const IconTopology = icon(Waypoints);

/* ------------------------------------------------------------- delta */
export const IconDeltaUp = icon(ArrowUp);
export const IconDeltaDown = icon(ArrowDown);
export const IconDeltaFlat = icon(Minus);
export const IconTrending = icon(TrendingUp);

/* -------------------------------------------------------------- sort */
/* One glyph per sorting state: a single arrow for the active direction and
   the paired arrow for a sortable-but-unsorted column. */
export const IconSortAsc = icon(ArrowUp);
export const IconSortDesc = icon(ArrowDown);
export const IconSortAscDesc = icon(ArrowUpDown);

/* ------------------------------------------------------------- state */
export const IconHealthy = icon(CircleCheck);
export const IconDegraded = icon(TriangleAlert);
export const IconFailed = icon(CircleSlash);
export const IconNotReporting = icon(CircleDashed);
export const IconInfo = icon(Info);

/* ------------------------------------- legacy names (kept for callers) */
export const IconTick = icon(TrendingUp);
export const IconAlert = icon(TriangleAlert);
export const IconBell = icon(Bell);
export const IconShield = icon(ShieldCheck);
export const IconPolicy = icon(KeyRound);
export const IconClock = icon(Clock);
export const IconLink = icon(Cable);
export const IconActivity = icon(Activity);
export const IconHome = icon(House);
export const IconCard = icon(CreditCard);
export const IconUser = icon(User);
export const IconServer = icon(Server);
export const IconLogout = icon(LogOut);
export const IconSearch = icon(Search);
export const IconRefresh = icon(RefreshCw);
export const IconChevronRight = icon(ChevronRight);
export const IconChevronDown = icon(ChevronDown);
export const IconPlus = icon(Plus);
export const IconEdit = icon(Pencil);
export const IconGrid = icon(LayoutGrid);
export const IconCheck = icon(CircleCheck);
export const IconVerified = icon(BadgeCheck);
