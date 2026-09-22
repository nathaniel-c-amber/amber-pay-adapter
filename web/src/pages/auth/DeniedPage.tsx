/* Denied — what a policy cannot read.
 *
 * The console previously handled a route its scope could not read by silently
 * redirecting to the first readable route. From the user's side that is
 * indistinguishable from a broken link: the page they asked for vanished and
 * they were somewhere else, with no statement that a decision had been made.
 *
 * Authorization that is invisible is indistinguishable from authorization that
 * is absent. So this states three things: which surface was refused, why, and
 * the one action that can change it.
 */

import type { PolicyScope } from "@/types/domain";
import { BTN } from "@/components/ui";
import { IconLock, IconShield, IconArrowRight } from "@/components/auth/authIcons";

export function DeniedPage({
  label,
  scope,
  onBack,
}: {
  /** Human name of the surface that was refused, e.g. "Findings". */
  label: string;
  /** The policy in force when the decision was made. */
  scope: PolicyScope | null;
  onBack: () => void;
}) {
  return (
    <div className="flex animate-[fadeIn_0.2s_ease-out] flex-col gap-4">
      <section
        className="flex max-w-[46rem] flex-col gap-3 rounded-panel border border-rule-enamel bg-midnight-2 p-6 shadow-panel"
        aria-labelledby="denied-title"
      >
        <span className="grid size-[38px] place-items-center rounded-panel bg-midnight-3 text-ink-3" aria-hidden>
          <IconLock size={20} />
        </span>

        <h2 className="text-xl font-semibold text-ink-1" id="denied-title">
          {label} is outside your policy scope
        </h2>

        <p className="m-0 max-w-[62ch] text-md leading-prose text-ink-2">
          Access here is evaluated per request from your policy attributes rather than from a fixed
          role, so this is a decision about this surface and this scope — not about your account as a
          whole.
        </p>

        {scope && (
          <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-x-5 gap-y-3 border-t border-rule-enamel-soft pt-3">
            <div>
              <dt className="text-micro uppercase tracking-label text-ink-3">Active policy</dt>
              <dd className="mt-1 text-sm text-ink-1 wrap-anywhere">{scope.label}</dd>
            </div>
            <div>
              <dt className="text-micro uppercase tracking-label text-ink-3">Attributes</dt>
              <dd className="mono mt-1 text-sm text-ink-1 wrap-anywhere">{scope.attributes}</dd>
            </div>
            {scope.readOnly && (
              <div>
                <dt className="text-micro uppercase tracking-label text-ink-3">Mode</dt>
                <dd className="mt-1 text-sm text-ink-1 wrap-anywhere">Read-only</dd>
              </div>
            )}
          </dl>
        )}

        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${BTN} gap-x-1.5 gap-y-1.5`} onClick={onBack}>
            <IconArrowRight />
            Return to a permitted surface
          </button>
        </div>

        <p className="m-0 flex max-w-[66ch] items-start gap-2 border-t border-rule-enamel-soft pt-3 text-sm leading-prose text-ink-3">
          <span className="mt-[0.15em] grid flex-none place-items-center text-ink-3" aria-hidden>
            <IconShield size={14} />
          </span>
          Switch the active scope in the top bar if you hold more than one. Otherwise, an
          administrator at your organisation can extend this policy — the console cannot grant
          itself access.
        </p>
      </section>
    </div>
  );
}
