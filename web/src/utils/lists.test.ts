import { describe, it, expect } from "vitest";
import { COLLAPSED_LIMIT, EXPANDED_LIMIT, capList, ceilingNotice } from "@/utils/lists";

const rows = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("capping a list", () => {
  it("shows a short list whole", () => {
    const out = capList(rows(3), false);

    expect(out.visible).toEqual([0, 1, 2]);
    expect(out.hidden).toBe(0);
    expect(out.atCeiling).toBe(false);
  });

  it("holds a long list back to the collapsed limit", () => {
    const out = capList(rows(22), false);

    expect(out.visible).toHaveLength(COLLAPSED_LIMIT);
    // Every row not rendered, not just the ones past the ceiling.
    expect(out.hidden).toBe(17);
  });

  it("reveals up to fifty when the operator asks for more", () => {
    const out = capList(rows(22), true);

    expect(out.visible).toHaveLength(22);
    expect(out.hidden).toBe(0);
  });

  it("stops at the ceiling rather than rendering hundreds of rows", () => {
    const out = capList(rows(500), true);

    expect(out.visible).toHaveLength(EXPANDED_LIMIT);
    expect(out.hidden).toBe(450);
    expect(out.atCeiling).toBe(true);
  });

  it("reports the ceiling only when there is one", () => {
    expect(capList(rows(50), true).atCeiling).toBe(false);
    expect(capList(rows(51), true).atCeiling).toBe(true);
  });

  it("distinguishes what is hidden from what is reachable", () => {
    // 500 rows collapsed to 5: 495 are hidden, but one "show more" only reaches
    // 50, so a button labelled with the hidden count would overstate itself.
    const out = capList(rows(500), false);

    expect(out.hidden).toBe(495);
    expect(out.reachable).toBe(EXPANDED_LIMIT);
    expect(out.total).toBe(500);
  });

  it("handles an empty list", () => {
    const out = capList([], false);

    expect(out.visible).toEqual([]);
    expect(out.hidden).toBe(0);
    expect(out.atCeiling).toBe(false);
  });
});

describe("the ceiling notice", () => {
  it("points at the event log once the ceiling is hit", () => {
    expect(ceilingNotice(capList(rows(500), true))).toBe(
      "Showing 50 of 500. The complete set is in the event log.",
    );
  });

  it("says nothing while the full list still fits", () => {
    expect(ceilingNotice(capList(rows(22), true))).toBeNull();
    expect(ceilingNotice(capList(rows(50), true))).toBeNull();
  });

  it("says nothing before the operator has expanded a long list", () => {
    // Claiming "showing 50 of 500" while 5 are on screen would be false.
    expect(ceilingNotice(capList(rows(500), false))).toBeNull();
  });
});
