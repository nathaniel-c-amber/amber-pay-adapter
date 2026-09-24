/* The wizard's step navigator.
 *
 * NAVIGATION, NOT DECORATION. It is an ordered list because the steps have a real
 * order, `aria-current="step"` marks where you are, and each step that can be
 * visited is a button reachable by keyboard — the five steps are the fastest way
 * back to something you want to change, so they have to be operable rather than a
 * picture of progress.
 *
 * STEPS BEYOND THE FIRST UNFINISHED ONE ARE NOT BUTTONS. They are rendered as
 * plain text rather than as disabled buttons: a disabled control is a promise of an
 * action, and the wizard genuinely cannot skip ahead of what it has not yet
 * validated (the server owns the choice, and the next step's form depends on it).
 * The full list is still visible, so the shape of the whole job is legible from
 * step one.
 */

import { cx } from "@/components/ui";
import type { WizardStep, WizardStepId } from "@/utils/settingsRules";

export function Stepper({
  steps,
  current,
  furthestReachable,
  onSelect,
}: {
  steps: readonly WizardStep[];
  current: WizardStepId;
  /** Index of the furthest step the operator has validated. */
  furthestReachable: number;
  onSelect: (id: WizardStepId) => void;
}) {
  return (
    <nav aria-label="Setup steps">
      <ol className="m-0 flex list-none flex-wrap items-center gap-x-1 gap-y-2 p-0">
        {steps.map((step, index) => {
          const isCurrent = step.id === current;
          const isDone = index < furthestReachable;
          const reachable = index <= furthestReachable;

          /* Numbered while it is still to come, ticked once it is behind you, and
             always with the label — progress is never carried by colour alone. */
          const mark = isDone ? "✓" : String(index + 1);

          const content = (
            <>
              <span className="mono text-micro" aria-hidden>
                {mark}
              </span>
              <span>{step.label}</span>
            </>
          );

          return (
            <li key={step.id} className="flex items-center gap-1">
              {index > 0 && <span aria-hidden className="h-px w-4 flex-none bg-rule-enamel" />}
              {reachable ? (
                <button
                  type="button"
                  onClick={() => onSelect(step.id)}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cx(
                    "inline-flex cursor-pointer items-center gap-2 rounded-panel border px-2.5 py-1.5 text-xs transition-colors",
                    isCurrent && "border-primary bg-primary-soft font-semibold text-primary-ink",
                    !isCurrent && "border-rule-enamel bg-midnight-2 text-ink-2 hover:border-ink-4",
                  )}
                >
                  {content}
                </button>
              ) : (
                <span
                  className="inline-flex items-center gap-2 rounded-panel border border-rule-enamel-soft px-2.5 py-1.5 text-xs text-ink-4"
                  aria-current={isCurrent ? "step" : undefined}
                >
                  <span className="sr-only">Step {index + 1}, not yet available: </span>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
