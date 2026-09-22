/* Password requirements, resolving as the user types.
 *
 * Shown before submit rather than as a wall of red after it. The rule itself
 * comes from `utils/passwordRules.ts`, so this component is only presentation
 * and cannot disagree with what the server enforces.
 */

import { useMemo } from "react";
import { cx } from "@/components/ui";
import { IconCheck } from "./authIcons";
import { evaluatePasswordRules } from "@/utils/passwordRules";

export function PasswordRequirements({
  value,
  id,
}: {
  value: string;
  /** Referenced by the input's `aria-describedby`. */
  id: string;
}) {
  const rules = useMemo(() => evaluatePasswordRules(value), [value]);

  return (
    <ul
      className="-mt-1.5 grid list-none grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-3 gap-y-1 p-0 max-xs:grid-cols-[minmax(0,1fr)]"
      id={id}
    >
      {rules.map((rule) => (
        <li
          key={rule.id}
          className={cx(
            "flex items-center gap-1.5 text-xs",
            rule.ok ? "text-ink-2" : "text-ink-3",
          )}
        >
          <span
            className={cx("grid size-[14px] flex-none place-items-center", rule.ok && "text-line-green")}
            aria-hidden
          >
            {rule.ok ? <IconCheck size={14} /> : <span className="size-[5px] rounded-full bg-ink-4" />}
          </span>
          <span>{rule.label}</span>
          <span className="sr-only">{rule.ok ? " — met" : " — not yet met"}</span>
        </li>
      ))}
    </ul>
  );
}
