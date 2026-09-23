/* The `data-tour` vocabulary — the ONE place that knows the attribute name.
 *
 * The tour has to point at elements it does not own: a control in `Shell`, a
 * card in a page, a primitive in `ui.tsx`. Refs would mean prop-drilling a
 * registration callback through all three, and a CSS class would collide with
 * the design system. A `data-` attribute is a contract any of those components
 * can satisfy without knowing the tour exists.
 *
 * Names are declared here rather than written as literals at both ends, so a
 * typo is a compile error. That matters more than usual: a step whose anchor
 * never appears is SKIPPED by design, which is exactly what makes a typo'd
 * anchor name fail quietly instead of loudly.
 */

export const T_ANCHOR = {
  /** The flow ledger on the Overview — the console's hero reading. */
  flowSpine: "flow-spine",
  /** The findings bell in the header. */
  findingsBell: "findings-bell",
  /** The identity block in the sidebar footer (account + scope). */
  sidebarIdentity: "sidebar-identity",
  /** The Profile control that replays the tour. */
  profileReplay: "profile-replay",
} as const;

export type TourAnchorName = (typeof T_ANCHOR)[keyof typeof T_ANCHOR];

/**
 * A navigation item's anchor, derived from its page id.
 *
 * Nav items come from the `NAV` list, so their anchors are generated rather than
 * hand-written — one per `PageId`, and a step targeting one cannot disagree with
 * the list it points into.
 */
export function navAnchor(pageId: string): string {
  return `nav-${pageId}`;
}

/**
 * Is this anchor inside the sidebar?
 *
 * At the drawer tier (<=720px) the sidebar is off-screen and `inert`, so a step
 * anchored on a nav item or the account footer has to open the drawer first —
 * otherwise the spotlight lands on an off-screen element and the panel points at
 * nothing visible.
 */
export function anchorNeedsDrawer(anchor: string | null): boolean {
  return anchor !== null && (anchor === T_ANCHOR.sidebarIdentity || anchor.startsWith("nav-"));
}

/** The CSS selector for an anchor. The one place that knows the attribute. */
export function anchorSelector(anchor: string): string {
  return `[data-tour="${anchor}"]`;
}
