/* The password rule, in one place.
 *
 * Mirrors `passwordSchema` in server/src/controllers/auth.controller.ts and
 * `assertStrongPassword` in server/src/utils/passwords.ts. It lived inline in
 * the invite screen; the reset screen needs the identical rule, and two copies
 * of an authentication rule drift apart at the worst possible moment — the user
 * is told a password is fine and then rejected by the server.
 *
 * Pure data + predicates, no React, so both screens (and any future one) share
 * exactly one definition.
 */

export interface PasswordRule {
  id: string;
  label: string;
  test: (value: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { id: "length", label: "At least 12 characters", test: (v) => v.length >= 12 },
  { id: "lower", label: "A lowercase letter", test: (v) => /[a-z]/.test(v) },
  { id: "upper", label: "An uppercase letter", test: (v) => /[A-Z]/.test(v) },
  { id: "digit", label: "A digit", test: (v) => /\d/.test(v) },
];

/** Evaluate every rule against a candidate password. */
export function evaluatePasswordRules(
  value: string,
): Array<PasswordRule & { ok: boolean }> {
  return PASSWORD_RULES.map((rule) => ({ ...rule, ok: rule.test(value) }));
}

/** True when the password satisfies every rule the server will enforce. */
export function meetsPasswordRules(value: string): boolean {
  return PASSWORD_RULES.every((rule) => rule.test(value));
}
