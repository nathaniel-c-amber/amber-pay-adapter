import { describe, it, expect } from "vitest";
import { adaptorRefsForGroup, groupFindings, groupIds, groupKey, openGroupIds, relatedEventsFor } from "@/utils/findings";
import type { Failure } from "@/types/domain";
import type { LifecycleEvent } from "@/types/domain";

/** One reported failure. `at` drives ordering, so it is the only required field. */
const failure = (id: string, over: Partial<Failure> = {}): Failure => ({
  id,
  severity: "critical",
  channel: "accounting",
  title: "QuickBooks Online is not answering",
  detail: "operation was aborted due to timeout",
  since: "2026-10-06T16:04:00.000Z",
  ...over,
});

describe("grouping findings into incidents", () => {
  it("collapses identical problems into one incident", () => {
    const groups = groupFindings([failure("a"), failure("b"), failure("c")]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.occurrences).toBe(3);
    expect(groups[0]!.members).toHaveLength(3);
  });

  it("keeps genuinely different problems apart", () => {
    const groups = groupFindings([
      failure("a"),
      failure("b", { title: "QuickBooks Online rejected our credentials" }),
      failure("c", { title: "QuickBooks Online is not answering", channel: "payment" }),
    ]);

    expect(groups).toHaveLength(3);
  });

  it("spans first and last occurrence", () => {
    const group = groupFindings([
      failure("a", { since: "2026-10-06T16:04:00.000Z" }),
      failure("b", { since: "2026-10-06T16:42:00.000Z" }),
      failure("c", { since: "2026-10-06T16:11:00.000Z" }),
    ])[0]!;

    expect(group.firstSeen).toBe("2026-10-06T16:04:00.000Z");
    expect(group.lastSeen).toBe("2026-10-06T16:42:00.000Z");
  });

  it("orders members newest first regardless of input order", () => {
    const group = groupFindings([
      failure("old", { since: "2026-10-06T16:04:00.000Z" }),
      failure("new", { since: "2026-10-06T16:42:00.000Z" }),
    ])[0]!;

    expect(group.members.map((m) => m.id)).toEqual(["new", "old"]);
  });

  /*
    Vary DETAIL and keep title+channel: detail is operational prose that changes
    between occurrences of one fault (a different URL, a different error), so a
    group that split on it would shatter one broken integration into a dozen
    "different" incidents — the exact noise grouping exists to remove.
  */
  it("groups on channel and title, not on varying detail", () => {
    const group = groupFindings([
      failure("a", { detail: "timeout calling /company/934/v3/companyinfo" }),
      failure("b", { detail: "timeout calling /company/935/v3/companyinfo" }),
      failure("c", { detail: "socket hang up" }),
    ])[0]!;

    expect(group.occurrences).toBe(3);
  });

  it("takes the most severe member so a group never reads quieter than its worst part", () => {
    const group = groupFindings([
      failure("a", { severity: "attention" }),
      failure("b", { severity: "critical" }),
    ])[0]!;

    expect(group.severity).toBe("critical");
  });

  it("sorts critical incidents before warnings", () => {
    const groups = groupFindings([
      failure("warn", { severity: "attention", title: "Payment push to adaptor failed" }),
      failure("crit", { title: "QuickBooks Online is not answering" }),
    ]);

    expect(groups[0]!.title).toBe("QuickBooks Online is not answering");
  });

  it("handles an empty queue", () => {
    expect(groupFindings([])).toEqual([]);
  });

  describe("a group that is partly acknowledged", () => {
    // An operator acknowledged what existed at 16:04; more arrived after.
    const partial = () =>
      groupFindings([
        failure("acked", {
          acknowledgedAt: "2026-10-06T16:10:00.000Z",
          acknowledgedBy: "alice@example.com",
        }),
        failure("open-a"),
        failure("open-b"),
      ])[0]!;

    it("is still open, because an unacknowledged occurrence is still being reported", () => {
      expect(partial().open).toBe(true);
    });

    it("counts what is still outstanding", () => {
      expect(partial().openCount).toBe(2);
    });

    it("keeps the whole incident's occurrences", () => {
      expect(partial().occurrences).toBe(3);
    });

    it("is closed once every occurrence is acknowledged", () => {
      const done = groupFindings([
        failure("a", { acknowledgedAt: "2026-10-06T16:10:00.000Z" }),
        failure("b", { acknowledgedAt: "2026-10-06T16:20:00.000Z" }),
      ])[0]!;

      expect(done.open).toBe(false);
      expect(done.openCount).toBe(0);
    });
  });

  describe("attribution", () => {
    it("records who acknowledged it most recently", () => {
      const group = groupFindings([
        failure("a", {
          acknowledgedAt: "2026-10-06T16:10:00.000Z",
          acknowledgedBy: "alice@example.com",
        }),
        failure("b", {
          acknowledgedAt: "2026-10-06T16:20:00.000Z",
          acknowledgedBy: "bob@example.com",
        }),
      ])[0]!;

      expect(group.acknowledgedBy).toBe("bob@example.com");
      expect(group.acknowledgedAt).toBe("2026-10-06T16:20:00.000Z");
    });

    /*
      Rows acknowledged before attribution existed have a timestamp and no actor.
      "We do not know" and "" are different claims, so the absent actor must
      survive as absent rather than being flattened into an empty string — a blank
      would render as though nobody had ever looked at the incident.
    */
    it("leaves the actor absent when the record carries none", () => {
      const group = groupFindings([
        failure("a", { acknowledgedAt: "2026-10-06T16:10:00.000Z" }),
      ])[0]!;

      expect(group.acknowledgedAt).toBe("2026-10-06T16:10:00.000Z");
      expect(group.acknowledgedBy).toBeUndefined();
      expect("acknowledgedBy" in group).toBe(true);
    });

    it("does not borrow an older name for an actorless latest acknowledgement", () => {
      const group = groupFindings([
        failure("a", {
          acknowledgedAt: "2026-10-06T16:10:00.000Z",
          acknowledgedBy: "alice@example.com",
        }),
        failure("b", { acknowledgedAt: "2026-10-06T16:20:00.000Z" }),
      ])[0]!;

      expect(group.acknowledgedAt).toBe("2026-10-06T16:20:00.000Z");
      expect(group.acknowledgedBy).toBeUndefined();
    });

    it("carries no acknowledgement at all for a fully open incident", () => {
      const group = groupFindings([failure("a")])[0]!;

      expect(group.acknowledgedAt).toBeUndefined();
      expect(group.acknowledgedBy).toBeUndefined();
    });
  });

  describe("acknowledging", () => {
    it("acts on every occurrence in the group", () => {
      const group = groupFindings([failure("a"), failure("b")])[0]!;
      expect(groupIds(group)).toEqual(["a", "b"]);
    });

    it("bulk-acknowledges only the open occurrences", () => {
      const groups = groupFindings([
        failure("already", {
          since: "2026-10-06T16:00:00.000Z",
          acknowledgedAt: "2026-10-06T16:10:00.000Z",
          acknowledgedBy: "alice@example.com",
        }),
        failure("older-open", { since: "2026-10-06T16:04:00.000Z" }),
        failure("newer-open", { since: "2026-10-06T16:42:00.000Z" }),
      ]);

      // alice's attribution must not be overwritten by the next person to click.
      expect(openGroupIds(groups)).not.toContain("already");
      expect(openGroupIds(groups)).toEqual(["newer-open", "older-open"]);
    });

    it("sends nothing when there is nothing open", () => {
      const groups = groupFindings([
        failure("a", { acknowledgedAt: "2026-10-06T16:10:00.000Z" }),
      ]);

      expect(openGroupIds(groups)).toEqual([]);
    });
  });

  describe("the events belonging to an incident", () => {
    const event = (
      id: string,
      at: string,
      over: Partial<LifecycleEvent> = {},
    ): LifecycleEvent => ({
      id,
      at,
      type: "adaptor-unreachable",
      channel: "accounting",
      ref: "quickbooks",
      detail: "QuickBooks Online: timeout",
      ...over,
    });

    const group = (over: Partial<Parameters<typeof groupFindings>[0][number]> = {}) =>
      groupFindings([
        failure("a", { since: "2026-10-06T16:04:00.000Z", ...over }),
        failure("b", { since: "2026-10-06T16:42:00.000Z" }),
      ])[0]!;

    it("keeps only the incident's own channel", () => {
      const events = [
        event("in", "2026-10-06T16:10:00.000Z"),
        event("other", "2026-10-06T16:11:00.000Z", { channel: "payment" }),
      ];

      expect(relatedEventsFor(group(), events).map((e) => e.id)).toEqual(["in"]);
    });

    it("keeps the events reported while the incident was failing", () => {
      const events = [
        event("before", "2026-10-06T15:00:00.000Z"),
        event("mid", "2026-10-06T16:10:00.000Z"),
        event("mid2", "2026-10-06T16:30:00.000Z"),
        event("after", "2026-10-06T18:00:00.000Z"),
      ];

      // The 18:00 event is ordinary traffic on the same channel two hours later.
      // It is not part of this incident's story and must not be dragged in.
      expect(relatedEventsFor(group(), events).map((e) => e.id)).toEqual(["mid", "mid2"]);
    });

    /*
      The reason this matches a window instead of joining on ids: the recovery
      is the most useful event in the story and it is NOT one of the failures.
      An exact id join would return the failures and silently drop the moment the
      adaptor came back.
    */
    it("includes the recovery that closed the incident, even though it is not a failure", () => {
      const events = [
        event("fail-1", "2026-10-06T16:10:00.000Z"),
        event("fail-2", "2026-10-06T16:30:00.000Z"),
        event("restored", "2026-10-06T16:50:00.000Z", {
          type: "adaptor-restored",
          detail: "QuickBooks Online is reachable again",
        }),
        event("much-later", "2026-10-06T19:00:00.000Z"),
      ];

      // The last occurrence is 16:42, so the recovery at 16:50 sits outside the
      // window — and dropping it would say the adaptor never came back.
      expect(relatedEventsFor(group(), events).map((e) => e.id)).toEqual([
        "fail-1",
        "fail-2",
        "restored",
      ]);
    });

    it("does not treat an ordinary later event as the recovery", () => {
      const events = [
        event("fail-1", "2026-10-06T16:10:00.000Z"),
        event("something-else", "2026-10-06T18:00:00.000Z", { type: "adaptor-auth-failed" }),
      ];

      expect(relatedEventsFor(group(), events).map((e) => e.id)).toEqual(["fail-1"]);
    });

    it("excludes the previous incident's aftermath", () => {
      const events = [
        event("previous-restored", "2026-10-06T15:59:00.000Z", { type: "adaptor-restored" }),
        event("fail-1", "2026-10-06T16:10:00.000Z"),
      ];

      expect(relatedEventsFor(group(), events).map((e) => e.id)).toEqual(["fail-1"]);
    });

    it("returns nothing for a channel with no events", () => {
      expect(relatedEventsFor(group(), [])).toEqual([]);
      expect(
        relatedEventsFor(group(), [event("elsewhere", "2026-10-06T16:10:00.000Z", { channel: "webhook" })]),
      ).toEqual([]);
    });

    it("still returns the following event for a single-occurrence incident", () => {
      const single = groupFindings([failure("only", { since: "2026-10-06T16:04:00.000Z" })])[0]!;
      const events = [
        event("fail", "2026-10-06T16:04:00.000Z"),
        event("restored", "2026-10-06T16:05:00.000Z", { type: "adaptor-restored" }),
      ];

      expect(relatedEventsFor(single, events).map((e) => e.id)).toEqual(["fail", "restored"]);
    });

    it("is not disturbed by events arriving out of order", () => {
      const shuffled = [
        event("fail-2", "2026-10-06T16:30:00.000Z"),
        event("restored", "2026-10-06T16:31:00.000Z", { type: "adaptor-restored" }),
        event("fail-1", "2026-10-06T16:10:00.000Z"),
      ];

      expect(relatedEventsFor(group(), shuffled).map((e) => e.id)).toEqual([
        "fail-1",
        "fail-2",
        "restored",
      ]);
    });
  });

  describe("the incident-to-connector join", () => {
    const event = (
      id: string,
      at: string,
      ref: string,
      over: Partial<LifecycleEvent> = {},
    ): LifecycleEvent => ({
      id,
      at,
      type: "adaptor-unreachable",
      channel: "accounting",
      ref,
      detail: "QuickBooks Online: timeout",
      ...over,
    });

    const incident = () =>
      groupFindings([
        failure("a", { since: "2026-10-06T16:04:00.000Z" }),
        failure("b", { since: "2026-10-06T16:42:00.000Z" }),
      ])[0]!;

    it("names the adaptor its events were recorded against", () => {
      const refs = adaptorRefsForGroup(incident(), [
        event("e1", "2026-10-06T16:10:00.000Z", "quickbooks"),
        event("e2", "2026-10-06T16:50:00.000Z", "quickbooks", { type: "adaptor-restored" }),
      ]);

      expect([...refs]).toEqual(["quickbooks"]);
    });

    /*
      The join used to compare `channel` ("accounting") with a connector's
      `label` ("QuickBooks Online"), which can never match — so every lookup came
      back empty and the affected-connection panel could only ever render its
      empty state. This pins the shape that actually holds.
    */
    it("matches a connector whose id is that adaptor, and not one named after it", () => {
      const refs = adaptorRefsForGroup(incident(), [
        event("e1", "2026-10-06T16:10:00.000Z", "quickbooks"),
      ]);

      const connector = { id: "quickbooks", label: "QuickBooks Online" };
      expect(refs.has(connector.id)).toBe(true);
      expect(refs.has(connector.label)).toBe(false);
    });

    it("returns nothing for a channel with no events", () => {
      expect(adaptorRefsForGroup(incident(), []).size).toBe(0);
    });

    it("collects every route a channel names, so no caller has to guess", () => {
      const refs = adaptorRefsForGroup(incident(), [
        event("e1", "2026-10-06T16:10:00.000Z", "quickbooks"),
        event("e2", "2026-10-06T16:20:00.000Z", "sage"),
      ]);

      expect(refs.has("quickbooks")).toBe(true);
      expect(refs.has("sage")).toBe(true);
    });
  });

  describe("the incident's URL key", () => {
    it("survives a title containing a slash and spaces", () => {
      const g = groupFindings([failure("a", { title: "Payments / adaptor / down now" })])[0]!;
      const key = groupKey(g);

      // A raw slash would be read as a route separator in the hash query.
      expect(key).not.toContain("/");
      expect(key).not.toContain(" ");
      expect(atob(key)).toBe("Payments / adaptor / down now");
    });
  });
});
