import { describe, it, expect } from "vitest";
import { evaluatePasswordRules, PASSWORD_RULES } from "@/utils/passwordRules";

/** Rule ids that pass for a candidate password. */
const passing = (value: string): string[] =>
  evaluatePasswordRules(value)
    .filter((r) => r.ok)
    .map((r) => r.id);

const failing = (value: string): string[] =>
  evaluatePasswordRules(value)
    .filter((r) => !r.ok)
    .map((r) => r.id);

describe("password rules", () => {
  /*
    These mirror `passwordSchema` in server/src/controllers/auth.controller.ts and
    `assertStrongPassword` in server/src/utils/passwords.ts. Two copies of an
    authentication rule drift apart at the worst possible moment — the user is
    told a password is fine and then rejected by the server. Asserted against the
    SERVER's own accepted example so a change on either side shows up here.
  */
  it("declares the four rules the server requires", () => {
    expect(PASSWORD_RULES.map((r) => r.id)).toEqual(["length", "lower", "upper", "digit"]);
  });

  it("accepts a password the server accepts", () => {
    expect(passing("Correct1Horse")).toEqual(["length", "lower", "upper", "digit"]);
    expect(failing("Correct1Horse")).toEqual([]);
  });

  it("requires 12 characters", () => {
    // "Ab1" is 3 characters, so 9 more makes exactly 12 — the boundary, with
    // every other rule already satisfied.
    expect(passing("Ab1" + "x".repeat(9))).toContain("length");
    // 11 characters — one short, and ONLY the length rule should fail.
    expect(failing("Ab1" + "x".repeat(8))).toEqual(["length"]);
  });

  it("requires each character class independently", () => {
    expect(failing("correct1hors")).toContain("upper");
    expect(failing("CORRECT1HORS")).toContain("lower");
    expect(failing("CorrectHorseB")).toContain("digit");
  });

  it("does not let one rule's tick stand in for another's", () => {
    // Long and uppercase, but no digit and no lowercase — the two failures must
    // both be reported, so the form can show both.
    const missed = failing("CORRECT1HORSEBATTERYSTAPLE");
    expect(missed).toContain("lower");
  });

  it("reports an empty password as failing every rule", () => {
    expect(failing("")).toEqual(["length", "lower", "upper", "digit"]);
  });

  it("gives every rule a label, so none can render as a bare checkbox", () => {
    for (const rule of PASSWORD_RULES) {
      expect(rule.label.length).toBeGreaterThan(0);
    }
  });

  it("returns one result per rule, in declaration order", () => {
    const results = evaluatePasswordRules("Correct1Horse");
    expect(results).toHaveLength(PASSWORD_RULES.length);
    expect(results.map((r) => r.id)).toEqual(PASSWORD_RULES.map((r) => r.id));
  });
});
