import { useRef } from "react";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * A view switcher — the thing you are LOOKING AT.
 *
 * WHY THIS EXISTS RATHER THAN A SECOND PILL ROW. Findings used to offer two
 * segmented controls directly stacked, built from the same constant, looking
 * identical: a severity filter and an open/acknowledged switch. Two different
 * axes rendered as siblings, so nothing told the operator which one they were
 * operating — and when both rows happened to show the same number, it read as a
 * bug rather than as two axes agreeing.
 *
 * A tab and a filter are not the same control. A filter narrows what you are
 * looking at; a tab changes what you are looking at. Giving them different
 * treatments is not decoration — it is the only thing that makes the distinction
 * legible at a glance. The tab is underlined and full-height; the filter chips
 * stay small and rounded.
 *
 * Built entirely from existing tokens: no new colour, no new radius, no new
 * spacing step. Only the treatment differs.
 */
export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** Rendered after the label. A count belongs here, not inside the label text. */
  count?: number;
  /** Tells the operator what the tab would contain, not just how many. */
  hint?: string;
}

const TAB_BASE =
  "relative -mb-px inline-flex cursor-pointer items-baseline gap-2 border-b-2 px-1 pb-2.5 pt-1 text-sm transition-colors";

export function Tabs<T extends string>({
  items,
  active,
  onChange,
  label,
  idPrefix,
}: {
  items: ReadonlyArray<TabItem<T>>;
  active: T;
  onChange: (id: T) => void;
  /** Names the group for assistive technology: "Acknowledgement status". */
  label: string;
  /** Prefix for each tab's DOM id; must be stable and unique on the page. */
  idPrefix: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  /*
    ARROW KEYS MOVE BETWEEN TABS, WHICH IS THE WHOLE POINT OF A TABLIST.
    Without this a keyboard user cannot reach the Acknowledged log at all —
    tabbing just leaves the control — so the second view of the queue would be
    unreachable without a mouse. Roving tabindex is what makes the group a single
    tab stop, and `preventDefault` is what stops the arrow keys from scrolling the
    page out from under the operator.
  */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;

    const current = items.findIndex((item) => item.id === active);
    if (current < 0) return;

    event.preventDefault();

    const last = items.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowRight"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;

    const target = items[next];
    if (!target) return;

    onChange(target.id);
    // Move focus with the selection, or the keyboard user is left on a tab that
    // is no longer selected and has no idea the view changed.
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${idPrefix}-${target.id}`)}`)
      ?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex flex-wrap gap-x-5 border-b border-rule-enamel"
    >
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            id={`${idPrefix}-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-${item.id}-panel`}
            // Roving tabindex: one tab stop for the whole group, arrows to move
            // within it.
            tabIndex={selected ? 0 : -1}
            title={item.hint}
            onClick={() => onChange(item.id)}
            className={cx(TAB_BASE, selected ? "border-primary text-ink-1" : "border-transparent text-ink-3 hover:text-ink-1")}
          >
            {item.label}
            {item.count !== undefined && (
              <span
                className={cx(
                  "mono text-xs",
                  selected ? "text-primary-ink" : "text-ink-3",
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a tab controls. `id` must match the tab's `aria-controls`. */
export function TabPanel({
  id,
  active,
  children,
  className,
}: {
  id: string;
  /** Whether this panel is the selected one, for `hidden`. */
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={id.replace(/-panel$/, "")}
      // Kept in the DOM rather than conditionally rendered so the operator's
      // scroll position and the refresh tick survive a tab switch, and so a
      // background refresh updates both views.
      hidden={!active}
      className={className}
    >
      {children}
    </div>
  );
}
