/* The first-run tour, as DATA.
 *
 * No JSX and no React: a step list is content, and keeping it declarative means
 * the wording can be reviewed (and translated) without reading an engine. The
 * engine in `engine.ts` owns when a step is shown; this file owns what it says.
 *
 * COPY RULES — learned from the surfaces themselves, not invented here:
 *  - Never name a nav LABEL. At 721-1024px the sidebar labels are hidden and the
 *    icons are the only thing on screen, so "the Connections label" is wrong at
 *    exactly the widths a laptop user is most likely to be at. Describe what the
 *    surface does instead.
 *  - Never promise a manual sync. The backend has no manual-sync route, so a
 *    step inviting the reader to "click Sync now" would teach a lie.
 *  - Every body must stay TRUE when the console is degraded. The tour can run
 *    against a backend that has never answered, so "you will see the number
 *    here" is only safe where the surface still says "not reporting".
 */

import { ABILITY } from "@/utils/permissions";
import { T_ANCHOR, navAnchor } from "./anchors";
import type { Ability } from "@/utils/permissions";
import type { RouteName } from "@/router";

export interface TourStep {
  /** Stable id. A test key, and the anchor for a future "resume where you were". */
  id: string;
  /** The route this step needs. The tour navigates here before showing it. */
  route: RouteName;
  /**
   * The `data-tour` name of the element to point at. Omit for a centred step.
   *
   * A step whose anchor never appears is SKIPPED, never shown unanchored: a
   * callout saying "here is the flow ledger" over a page that does not have one
   * is worse than no callout at all.
   */
  anchor?: string;
  title: string;
  body: string;
  /**
   * Policy gate. A step the policy cannot satisfy is skipped, never shown
   * disabled — the same rule the rest of the console applies to a hidden nav
   * item, page, or button. Access is attribute-driven, so there is no fixed
   * list of who sees what.
   */
  requires?: Ability;
  /** Preferred side for the panel. A preference only; the engine falls back. */
  placement?: "top" | "bottom" | "left" | "right" | "center";
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    route: "overview",
    requires: ABILITY.dashboardRead,
    title: "Welcome to Amber Pay Ledger",
    body: "This console watches the link between Amber Pay and your accounting software. Its job is to show whether payments are reaching the ledger, and to say so plainly when they are not. It takes about a minute.",
    placement: "center",
  },
  {
    id: "flow",
    route: "overview",
    anchor: T_ANCHOR.flowSpine,
    requires: ABILITY.dashboardRead,
    title: "How a payment moves",
    body: "Every payment passes through four stages: initiated, collected, ingested, posted. A stage with nothing in it reads \u201cnot reporting\u201d rather than healthy — an empty queue and a silent one are different things, and only one of them is good news.",
    placement: "bottom",
  },
  {
    id: "connections",
    route: "overview",
    anchor: navAnchor("connections"),
    requires: ABILITY.dashboardRead,
    title: "Connections",
    body: "Each connection is one route between the gateway and an accounting system. \u201cNo connection\u201d is a real answer rather than a missing one: it means that adaptor has not been authorized yet.",
    placement: "right",
  },
  {
    id: "findings",
    route: "overview",
    anchor: T_ANCHOR.findingsBell,
    requires: ABILITY.dashboardRead,
    title: "Findings",
    body: "Critical failures are collected here and stay open until somebody acknowledges them. Whether you can acknowledge one is decided by the policy your account holds, not by a fixed role.",
    placement: "bottom",
  },
  {
    id: "events",
    route: "overview",
    anchor: navAnchor("events"),
    requires: ABILITY.dashboardRead,
    title: "The event log",
    body: "Every lifecycle event, in order. You can open a stage in the ledger and see exactly the events it was counted from, so a figure never has to be taken on trust.",
    placement: "right",
  },
  {
    id: "privacy",
    route: "overview",
    requires: ABILITY.dashboardRead,
    title: "What is never here",
    body: "No amounts, no currency, no customer details, no card data. The console carries operational statuses and reference hashes only. That is a rule of the product, not a gap in it.",
    placement: "center",
  },
  {
    id: "scope",
    route: "overview",
    anchor: T_ANCHOR.sidebarIdentity,
    title: "Your access",
    body: "What you can see is what your policy grants. This footer names the account you are signed in as; the Profile page shows the scope, the organization and the actions behind it.",
    placement: "right",
  },
  {
    id: "done",
    route: "profile",
    anchor: T_ANCHOR.profileReplay,
    title: "That is the tour",
    body: "You can replay it from here whenever you like. Everything it pointed at is also reachable from the sidebar — nothing in the tour is hidden behind it.",
    placement: "top",
  },
];
