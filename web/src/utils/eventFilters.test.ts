import { describe, it, expect } from "vitest";
import {
  ALL_TIME,
  EVENT_FAMILY,
  FAMILY_TYPES,
  NO_FILTERS,
  UNSETTLED_OUTCOMES,
  channelsPresent,
  connectionRefs,
  familyCounts,
  filterEvents,
  isUnfiltered,
  outcomeCounts,
} from "@/utils/eventFilters";
import type { EventFilters } from "@/utils/eventFilters";
import type { EventType, LifecycleEvent } from "@/types/domain";

/** A fixed "now" so window boundaries are asserted, not observed. */
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

const event = (
  id: string,
  type: EventType,
  at: string,
  over: Partial<LifecycleEvent> = {},
): LifecycleEvent => ({
  id,
  at,
  type,
  channel: "payment",
  ref: "ref-0001",
  detail: "detail",
  ...over,
});

const filters = (over: Partial<EventFilters> = {}): EventFilters => ({
  ...NO_FILTERS,
  ...over,
});

describe("event families", () => {
  it("assigns every event type to exactly one family", () => {
    // A type missing from the map would crash `familyCounts` rather than
    // quietly vanish, so the coverage is what matters here.
    expect(Object.keys(EVENT_FAMILY)).toHaveLength(11);
  });

  it("derives family membership from the map, so the two cannot disagree", () => {
    expect(FAMILY_TYPES.payment).toContain("payment-declined");
    expect(FAMILY_TYPES.accounting).toContain("webhook-received");
    expect(FAMILY_TYPES.infrastructure).toContain("adaptor-restored");
    // The split that already existed in the event table's sort order.
    expect(FAMILY_TYPES.infrastructure).not.toContain("collected");
    expect(FAMILY_TYPES.payment).not.toContain("adaptor-unreachable");
  });
});

describe("filtering events", () => {
  const mixed = [
    event("a", "collected", "2026-10-07T11:59:00.000Z"),
    event("b", "payment-declined", "2026-10-07T11:00:00.000Z"),
    event("c", "payment-failed", "2026-10-07T06:00:00.000Z"),
    event("d", "adaptor-unreachable", "2026-10-06T12:00:00.000Z", {
      channel: "accounting",
      ref: "quickbooks",
    }),
    event("e", "webhook-received", "2026-09-20T12:00:00.000Z", {
      channel: "webhook",
      ref: "ref-0002",
    }),
  ];

  it("returns everything when nothing is selected", () => {
    expect(filterEvents(mixed, NO_FILTERS, NOW)).toHaveLength(5);
  });

  it("narrows to a family", () => {
    const out = filterEvents(mixed, filters({ families: new Set(["payment"]) }), NOW);
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("unions the selections within one axis", () => {
    // "declined OR failed" is the pairing the page's own KPI counts.
    const out = filterEvents(
      mixed,
      filters({ outcomes: new Set(UNSETTLED_OUTCOMES) }),
      NOW,
    );
    expect(out.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("intersects the axes with each other", () => {
    // Payment AND last hour: 'c' is a payment but is outside the hour.
    const out = filterEvents(
      mixed,
      filters({ families: new Set(["payment"]), window: { kind: "preset", preset: "1h" } }),
      NOW,
    );
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("narrows by channel", () => {
    const out = filterEvents(mixed, filters({ channels: new Set(["accounting"]) }), NOW);
    expect(out.map((e) => e.id)).toEqual(["d"]);
  });

  it("narrows by connection", () => {
    const out = filterEvents(mixed, filters({ connections: new Set(["quickbooks"]) }), NOW);
    expect(out.map((e) => e.id)).toEqual(["d"]);
  });

  describe("the time window", () => {
    it("keeps only events inside a preset", () => {
      expect(
        filterEvents(mixed, filters({ window: { kind: "preset", preset: "24h" } }), NOW).map(
          (e) => e.id,
        ),
      ).toEqual(["a", "b", "c", "d"]);
    });

    it("keeps everything when the preset is All", () => {
      expect(filterEvents(mixed, filters({ window: ALL_TIME }), NOW)).toHaveLength(5);
    });

    it("honours a custom range at both ends", () => {
      const out = filterEvents(
        mixed,
        filters({
          // Chosen so one event falls before the start, one after the end, and
          // one inside — otherwise the test passes with only one bound working.
          window: { kind: "custom", from: "2026-10-07T10:00:00", to: "2026-10-07T11:30:00" },
        }),
        NOW,
      );
      // 'b' (11:00) is inside; 'c' (06:00) is before the start; 'a' (11:59) after the end.
      expect(out.map((e) => e.id)).toEqual(["b"]);
    });

    /*
      An unparseable timestamp is a fact about the data, not a reason to hide the
      row. Dropping it would turn a data problem into a suspiciously empty list.
    */
    it("keeps an event whose timestamp cannot be read", () => {
      const broken = [event("broken", "collected", "not-a-date")];
      const out = filterEvents(
        broken,
        filters({ window: { kind: "preset", preset: "1h" } }),
        NOW,
      );
      expect(out.map((e) => e.id)).toEqual(["broken"]);
    });

    it("treats an unreadable custom bound as no bound", () => {
      const out = filterEvents(
        mixed,
        filters({ window: { kind: "custom", from: "nonsense", to: "nonsense" } }),
        NOW,
      );
      expect(out).toHaveLength(5);
    });
  });
});

describe("what the toolbar needs to know", () => {
  const mixed = [
    event("a", "collected", "2026-10-07T11:59:00.000Z", { channel: "payment" }),
    event("b", "adaptor-unreachable", "2026-10-07T11:00:00.000Z", {
      channel: "accounting",
      ref: "quickbooks",
    }),
    event("c", "webhook-received", "2026-10-07T06:00:00.000Z", {
      channel: "webhook",
      ref: "ref-0002",
    }),
  ];

  it("lists connections as distinct refs, sorted", () => {
    expect(connectionRefs(mixed)).toEqual(["quickbooks", "ref-0001", "ref-0002"]);
  });

  it("lists channels in the canonical order, not the order they appeared", () => {
    expect(channelsPresent(mixed)).toEqual(["payment", "accounting", "webhook"]);
  });

  it("counts each family", () => {
    expect(familyCounts(mixed)).toEqual({ payment: 1, accounting: 1, infrastructure: 1 });
  });

  it("counts each payment outcome", () => {
    const counts = outcomeCounts(mixed);
    expect(counts.collected).toBe(1);
    expect(counts.declined).toBe(0);
  });
});

describe("knowing when nothing is filtered", () => {
  it("is true for the untouched state", () => {
    expect(isUnfiltered(NO_FILTERS)).toBe(true);
  });

  it("is false once any axis is set", () => {
    expect(isUnfiltered(filters({ channels: new Set(["payment"]) }))).toBe(false);
    expect(isUnfiltered(filters({ window: { kind: "preset", preset: "1h" } }))).toBe(false);
    expect(isUnfiltered(filters({ connections: new Set(["quickbooks"]) }))).toBe(false);
  });
});
