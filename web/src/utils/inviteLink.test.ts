import { describe, it, expect } from "vitest";
import { inviteLink } from "@/utils/inviteLink";

/*
  The link an administrator copies has to match the link the server emails and
  the route the hash router reads. Anything that drifts here is invisible in a
  build — it only shows up when a pasted link lands on the overview.
*/
describe("inviteLink", () => {
  it("builds the hash route the router resolves", () => {
    expect(inviteLink("https://console.example.com", "tok-1")).toBe(
      "https://console.example.com/#/invite/tok-1",
    );
  });

  it("tolerates a trailing slash on the base", () => {
    expect(inviteLink("https://console.example.com/", "tok-1")).toBe(
      "https://console.example.com/#/invite/tok-1",
    );
  });

  it("keeps a sub-path on the base", () => {
    expect(inviteLink("https://example.com/console", "tok-1")).toBe(
      "https://example.com/console/#/invite/tok-1",
    );
  });

  it("percent-encodes the token so it stays one path segment", () => {
    expect(inviteLink("https://c.example.com", "a b/c")).toBe(
      "https://c.example.com/#/invite/a%20b%2Fc",
    );
  });
});
