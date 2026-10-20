import { useEffect, useId, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { cx } from "./ui";
import { IconClose } from "./icons";

/* A modal dialog, for the one place the console must interrupt a list.
 *
 * WHY A DIALOG AND NOT AN INLINE PANEL. Editing somebody's access used to expand
 * a row in the middle of the directory: the table reflowed, every row below it
 * moved, and the control that had been clicked was no longer where the operator
 * had left it. A dialog leaves the list exactly where it was, so "cancel" means
 * what it says and the operator can see the rest of the directory while they
 * think about one person.
 *
 * THE BEHAVIOUR IS DELIBERATELY BORROWED FROM `TourLayer`, which is the only
 * other overlay here and is known to work: focus moves into the dialog on open,
 * Tab is trapped while it is up, Escape cancels, and focus returns to whatever
 * opened it. Getting this wrong is not cosmetic — a dialog that leaks focus to
 * the page behind it reads its still-inert controls to a screen reader as if
 * they were live.
 */

const TITLE_CLASS =
  "mono text-micro uppercase tracking-label text-ink-3";
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  eyebrow = "Editing",
  description,
  onClose,
  children,
  footer,
  width = "max-w-[40rem]",
  initialFocusRef,
}: {
  title: string;
  /**
   * The small label above the title. It used to be hardcoded to "Editing",
   * which read as a statement about what the dialog DOES rather than what it
   * is about — and it was wrong for every non-edit use, including a
   * confirmation that acknowledges findings. Defaults to "Editing" so an edit
   * dialog needs no change; anything else should say what it is.
   */
  eyebrow?: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  /**
   * Where focus lands when the dialog opens.
   *
   * Defaults to the heading, which is the right answer for an editing dialog:
   * the reader is told what they are editing before they are put in a field.
   * A destructive confirmation is the exception — it is handed the SAFE action,
   * so a stray Enter or Space cannot commit the thing being confirmed.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  /* One id pair per mounted dialog, so the title and description association
     cannot collide with another overlay and does not rely on a page-wide
     constant. */
  const titleId = useId();
  const descriptionId = useId();

  // Remember what opened us, so closing puts the operator back where they were.
  // Focus lands on the safe target when one is named; otherwise on the heading.
  useEffect(() => {
    returnTo.current = (document.activeElement as HTMLElement | null) ?? null;
    (initialFocusRef?.current ?? headingRef.current)?.focus();
    return () => returnTo.current?.focus?.();
    // Mount-only on purpose: re-running would re-capture `returnTo` and move
    // focus back to the top of a dialog the operator is already using.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
    Escape, and Tab, on the DOCUMENT rather than on the panel.

    A keydown handler on the panel only fires while focus is inside it, which is
    exactly when a Tab trap is needed and exactly when it does not help if focus
    escaped. Listening at the document catches Escape from anywhere, and lets the
    trap wrap focus that has already left.
  */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const current = document.activeElement;
      if (!event.shiftKey && (current === last || !panel.contains(current))) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (current === first || !panel.contains(current))) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    /*
      A full-bleed scrim, rendered inline. It is NOT a portal, and that is a
      decision rather than an omission: the console shell already marks its own
      content `inert` while the tour is up, and a portal would land outside that
      wrapper while a non-portal stays inside the console's own stacking context,
      where the header cannot paint over it.
    */
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgb(4_7_16/0.72)] p-4 pt-[8vh] max-xs:p-3 max-xs:pt-[4vh]"
      onMouseDown={(event) => {
        // A click that STARTS on the scrim is a dismissal; one that starts inside
        // the panel and ends on the scrim is a text selection being dragged out.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx(
          "flex w-full flex-col gap-4 rounded-panel border border-ink-4 bg-midnight-2 p-5 shadow-panel focus-visible:outline-none max-xs:p-4",
          width,
        )}
      >
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className={TITLE_CLASS}>{eyebrow}</p>
            <h2
              id={titleId}
              ref={headingRef}
              tabIndex={-1}
              className="m-0 text-lg font-semibold leading-tight text-ink-1 focus-visible:outline-none"
            >
              {title}
            </h2>
            {description && (
              <div id={descriptionId} className="m-0 mt-1 text-sm leading-prose text-ink-2">
                {description}
              </div>
            )}
          </div>
          {/*
            An ICON button, not a word.

            "Close" was a full-size pill button sitting beside the title, which
            gave a dismiss affordance the same visual weight as the dialog's own
            confirm action and made the two compete. A glyph carries the same
            meaning at a fraction of the width and leaves the title alone.

            The accessible name is now carried by `aria-label` rather than by
            text, so the control is still announced — the icon itself is
            `aria-hidden` in this set, which is exactly why the label is not
            optional.
          */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid flex-none cursor-pointer place-items-center rounded-chip border border-rule-enamel bg-midnight-3 px-1.5 py-1.5 text-ink-2 transition-colors hover:not-disabled:border-ink-4 hover:text-ink-1"
          >
            <IconClose className="size-4" />
          </button>
        </div>

        {children}

        {footer && (
          <div className="flex flex-wrap items-center gap-3 border-t border-rule-enamel pt-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
