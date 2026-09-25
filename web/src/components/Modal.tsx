import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { BTN, cx } from "./ui";

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
  description,
  onClose,
  children,
  footer,
  width = "max-w-[40rem]",
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // Remember what opened us, so closing puts the operator back where they were.
  useEffect(() => {
    returnTo.current = (document.activeElement as HTMLElement | null) ?? null;
    headingRef.current?.focus();
    return () => returnTo.current?.focus?.();
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
        aria-labelledby="modal-title"
        tabIndex={-1}
        className={cx(
          "flex w-full flex-col gap-4 rounded-panel border border-ink-4 bg-midnight-2 p-5 shadow-panel focus-visible:outline-none max-xs:p-4",
          width,
        )}
      >
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className={TITLE_CLASS}>Editing</p>
            <h2
              id="modal-title"
              ref={headingRef}
              tabIndex={-1}
              className="m-0 text-lg font-semibold leading-tight text-ink-1 focus-visible:outline-none"
            >
              {title}
            </h2>
            {description && (
              <div className="m-0 mt-1 text-sm leading-prose text-ink-2">{description}</div>
            )}
          </div>
          <button type="button" className={BTN} onClick={onClose}>
            Close
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
