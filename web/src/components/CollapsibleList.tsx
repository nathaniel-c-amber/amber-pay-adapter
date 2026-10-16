import { useState } from "react";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";
import { IconChevronRight } from "@/components/icons";
import { capList, ceilingNotice } from "@/utils/lists";

/**
 * A panel body that collapses to one line and reveals a bounded number of rows.
 *
 * Every list fed by an unbounded source needs the same three answers — how many
 * are there, how many can I see, how do I see the rest — and they were being
 * answered differently on each panel. This is that answer once.
 *
 * COLLAPSED IS THE DEFAULT. A monitoring console's panels are scanned, not read,
 * and a page whose default state is six hundred pixels of log below the fold
 * makes the operator scroll to find the summary that matters.
 *
 * The collapsed state keeps the COUNT visible. A collapsed panel that hides how
 * much is inside it is indistinguishable from one with nothing in it — and on a
 * page about failures, "is there something here" is the first question asked.
 */
export function CollapsibleList<T>({
  id,
  countLabel,
  summary,
  /** The rows to cap, in display order. */
  items,
  /** Rendered for one row. */
  renderItem,
  keyOf,
  /** Rendered under the rows when a "show more" would not reach everything. */
  overflowHref,
  empty,
  /** Extra control in the header, beside the disclosure — e.g. an ack toggle. */
  headerControl,
}: {
  /**
   * A STABLE id for the panel, supplied by the caller.
   *
   * It is not derived from `countLabel`: that label carries a live count and
   * changes as the list does, so a derived id would leave `aria-controls`
   * pointing at an element that no longer exists — which reads to assistive
   * technology as a disclosure controlling nothing.
   */
  id: string;
  /** Shown in the header in both states. Never hidden by collapsing. */
  countLabel: string;
  /** One line describing the collapsed contents. */
  summary: ReactNode;
  items: readonly T[];
  renderItem: (item: T, index: number) => ReactNode;
  keyOf: (item: T, index: number) => string;
  overflowHref?: { label: string; onClick: () => void };
  empty: ReactNode;
  headerControl?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const capped = capList(items, expanded);
  const notice = ceilingNotice(capped);
  const panelId = `${id}-panel`;
  // One click reveals the ceiling, not the whole set, so the label says what it
  // will actually reach rather than what exists.
  const revealable = capped.reachable - capped.visible.length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className={cx(
            "inline-flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-sm font-semibold text-ink-1",
          )}
        >
          <IconChevronRight
            className={cx("size-4 text-ink-3 transition-transform duration-[180ms] ease-out", open && "rotate-90")}
          />
          {countLabel}
        </button>
        {headerControl}
      </div>

      {!open ? (
        <p className="mt-1.5 text-sm text-ink-3">{summary}</p>
      ) : (
        <div id={panelId} className="mt-2">
          {capped.total === 0 ? (
            empty
          ) : (
            <>
              <div>
                {capped.visible.map((item, index) => (
                  <div key={keyOf(item, index)}>{renderItem(item, index)}</div>
                ))}
              </div>

              {revealable > 0 && (
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="mt-2 cursor-pointer border-0 bg-transparent p-0 text-sm font-semibold text-primary underline underline-offset-[0.18em] hover:text-primary-ink"
                >
                  Show {revealable} more
                </button>
              )}

              {notice && (
                <p className="mono mt-2 text-xs text-ink-3">
                  {notice}
                  {overflowHref && (
                    <>
                      {" "}
                      <button
                        type="button"
                        onClick={overflowHref.onClick}
                        className="cursor-pointer border-0 bg-transparent p-0 text-primary underline underline-offset-[0.18em] hover:text-primary-ink"
                      >
                        {overflowHref.label}
                      </button>
                    </>
                  )}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
