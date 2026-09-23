/* The authorization gate, as components.
 *
 * `web/src/utils/permissions.ts` owns the rules; this file is the seam that
 * lets a surface ask them without being handed a boolean. The shell publishes
 * the active policy once, so a control deep in the tree — a toggle inside a
 * card, an action inside a table row — asks the same question as the nav:
 *
 *     <Can ability={ABILITY.paymentsWrite}>  …control…  </Can>
 *     <Cannot ability={ABILITY.findingAck}>  …why it is absent…  </Cannot>
 *     const can = useCan();                  can(ABILITY.findingAck);
 *
 * That is Laravel's `@can` / `@cannot` / `Gate::forUser()->allows()`, and it
 * replaces the two things it should never have been: a `canEdit` boolean
 * threaded down through prop after prop, and a per-surface `disabled` state.
 *
 * HIDING, NOT DISABLING. A disabled control still advertises an operation the
 * policy cannot honour, and it says "you may not" where the honest answer is
 * "this is not your scope". The control is therefore absent, and — because
 * authorization that is invisible is indistinguishable from authorization that
 * is absent — the surrounding surface states the reason through `Cannot`.
 */

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { PolicyScope } from "@/types/domain";
import { canAny } from "@/utils/permissions";
import type { AbilitySet } from "@/utils/permissions";

/** `undefined` = no provider above us (a surface rendered outside the shell). */
const PolicyContext = createContext<PolicyScope | null | undefined>(undefined);

/**
 * Publish the active policy to every gate below it.
 *
 * `undefined` and `null` mean different things here and the distinction is
 * deliberate: `null` is a policy that has not loaded yet (demo mode included,
 * where the widest capability applies), while `undefined` means nobody
 * published one at all and the caller is outside the console.
 */
export function PolicyProvider({
  policy,
  children,
}: {
  policy: PolicyScope | null | undefined;
  children: ReactNode;
}) {
  return <PolicyContext.Provider value={policy}>{children}</PolicyContext.Provider>;
}

/** The active policy, for surfaces that quote it rather than test it. */
export function usePolicy(): PolicyScope | null | undefined {
  return useContext(PolicyContext);
}

/**
 * The gate bound to the active policy.
 *
 * Returns a function rather than a boolean because a page usually asks about
 * more than one operation; `useCan()` reads as `Gate::allows()` at the call
 * site.
 */
export function useCan(): (ability: AbilitySet) => boolean {
  const policy = usePolicy();
  return (ability: AbilitySet) => canAny(policy, ability);
}

/** `@can` — children render only when the policy grants the ability. */
export function Can({
  ability,
  fallback = null,
  children,
}: {
  /** One ability, or several satisfied by any of them. */
  ability: AbilitySet;
  /** Rendered in place of the children when the ability is not granted. */
  fallback?: ReactNode;
  children?: ReactNode;
}) {
  const can = useCan();
  return <>{can(ability) ? children : fallback}</>;
}

/** `@cannot` — the inverse, for the line that states why a control is absent. */
export function Cannot({ ability, children }: { ability: AbilitySet; children: ReactNode }) {
  const can = useCan();
  return <>{can(ability) ? null : children}</>;
}
