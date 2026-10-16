import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * A row of selectable filter chips.
 *
 * EXTRACTED, NOT INVENTED. This treatment already existed privately in the
 * Findings page as `FILTER_BTN` / `FILTER_ON` / `FILTER_OFF`, and the event log
 * and Payments page need the same thing. Three copies of three class strings is
 * how a design system quietly becomes three designs — the second copy drifts by
 * a padding step and nobody notices until they sit side by side.
 *
 * A CHIP, NOT A TAB. A chip narrows what is already in view; a tab changes what
 * is in view. They looked identical once on the Findings page and the page read
 * as two contradictory filters, so the distinction is deliberate: chips stay
 * small, rounded and inline, and the tab bar is underlined and full-height.
 */
export const CHIP =
  "inline-flex cursor-pointer items-center gap-2 rounded-chip border border-rule-enamel bg-midnight-2 px-3 py-1.5 text-sm hover:border-ink-4 hover:text-ink-1";
const CHIP_ON = "border-primary bg-sel-bg font-semibold text-ink-1";
const CHIP_OFF = "font-medium text-ink-2";

export interface ChipOption<T extends string> {
  id: T;
  label: string;
  /** Shown after the label. A count belongs here, not inside the label text. */
  count?: number;
  /** A chip that can select nothing is shown, not hidden — see below. */
  disabled?: boolean;
}

export function FilterChips<T extends string>({
  options,
  selected,
  onToggle,
  label,
  /** Rendered at the end of the row, e.g. a clear-all control. */
  trailing,
}: {
  options: ReadonlyArray<ChipOption<T>>;
  /**
   * The ids currently pressed.
   *
   * THE CALLER OWNS WHAT "SELECTED" MEANS, and the two pages use it differently
   * on purpose. The event log treats an empty set as "every value included", so
   * an untouched axis shows nothing pressed. Findings has an explicit `all` chip
   * and is single-select, so it passes exactly one id. Encoding either as the
   * component's own rule would force the other to fake it.
   */
  selected: ReadonlySet<T>;
  onToggle: (id: T) => void;
  /** Names the group for assistive technology: "Filter by channel". */
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      {options.map((option) => {
        const on = selected.has(option.id);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            disabled={option.disabled}
            onClick={() => onToggle(option.id)}
            className={cx(
              CHIP,
              on ? CHIP_ON : CHIP_OFF,
              /*
                A chip with a zero count stays visible and is NOT disabled: it is
                how the operator learns there is nothing there. Hiding it would
                make the toolbar reflow under their cursor, so the control they
                were reaching for moves the moment a refresh returns no matches.
              */
              option.disabled && "cursor-not-allowed opacity-45",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={cx("mono text-xs", on ? "text-primary-ink" : "text-ink-3")}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
      {trailing}
    </div>
  );
}

/**
 * Add or remove one value from a selection set.
 *
 * Selection sets are held as immutable `Set`s because they feed `useMemo`
 * dependencies, and a mutated Set compares equal to itself so the memo would
 * never recompute.
 */
export function toggleInSet<T>(current: ReadonlySet<T>, id: T): Set<T> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function toggleManyInSet<T>(current: ReadonlySet<T>, ids: readonly T[]): Set<T> {
  const next = new Set(current);
  const allOn = ids.every((id) => next.has(id));
  for (const id of ids) {
    if (allOn) next.delete(id);
    else next.add(id);
  }
  return next;
}
