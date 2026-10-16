import { describe, it, expect } from "vitest";
import {
  ADAPTOR_CHOICES,
  CONNECT_FAILURE_COPY,
  WIZARD_STEPS,
  adaptorChoice,
  connectOutcomeFromSearch,
  firstIncompleteStep,
  stepAt,
  stepIndex,
  validateAccounting,
  validateGateway,
  validateOrganizationName,
} from "@/utils/settingsRules";
import type { ApiDeploymentSettings } from "@/types/api";

const stored = (configured: boolean): ApiDeploymentSettings["gateway"]["webhookSecret"] => ({
  configured,
  lastFour: configured ? "VHNC" : null,
  unreadable: false,
});

/** A deployment with nothing configured yet. */
const BASE: ApiDeploymentSettings = {
  organizationId: "default",
  organizationName: null,
  gateway: { clientId: null, webhookSecret: stored(false) },
  adaptor: {
    id: null,
    realmId: null,
    baseUrl: null,
    credentials: { configured: false, lastFour: null, unreadable: false },
    canAuthorize: false,
    invoiceMatching: { strategy: null, mode: null, fieldName: null, depositAccountId: null },
  },
  syncInterval: null,
  alertTarget: null,
  verifiedAt: null,
  configuredAt: null,
  configured: false,
  writable: true,
};

/*
  The cast is deliberate. `Partial<>` plus a spread does not typecheck: an
  optional `gateway` in the overrides makes the merged `gateway`
  `{...} | undefined`, which no longer satisfies a required field — and the
  error surfaces deep inside `credential.configured`, far from the cause. The
  overrides are literals checked against this same shape at every call site, so
  nothing unsound reaches the functions under test.
*/
const settings = (over: Partial<ApiDeploymentSettings> = {}): ApiDeploymentSettings =>
  ({ ...BASE, ...over }) as ApiDeploymentSettings;

const CONFIGURED = settings({
  organizationName: "Northgate Academy",
  gateway: { clientId: "gw-1", webhookSecret: stored(true) },
  adaptor: {
    id: "quickbooks",
    realmId: "9341",
    baseUrl: null,
    credentials: { configured: true, lastFour: "beef", unreadable: false },
    canAuthorize: true,
    invoiceMatching: { strategy: null, mode: null, fieldName: null, depositAccountId: null },
  },
  verifiedAt: "2026-10-06T09:00:00.000Z",
  configuredAt: "2026-10-06T09:05:00.000Z",
});

describe("wizard steps", () => {
  it("clamps out-of-range indexes instead of returning undefined", () => {
    expect(stepAt(-5).id).toBe(WIZARD_STEPS[0].id);
    expect(stepAt(999).id).toBe(WIZARD_STEPS[WIZARD_STEPS.length - 1].id);
  });

  it("locates every declared step", () => {
    for (const step of WIZARD_STEPS) {
      expect(WIZARD_STEPS[stepIndex(step.id)].id).toBe(step.id);
    }
  });
});

describe("firstIncompleteStep", () => {
  it("walks the steps in dependency order, not alphabetically", () => {
    expect(firstIncompleteStep(settings())).toBe("organization");
    expect(firstIncompleteStep(settings({ organizationName: "Acme" }))).toBe("gateway");
    expect(
      firstIncompleteStep(settings({ organizationName: "Acme", gateway: { clientId: "g", webhookSecret: stored(true) } })),
    ).toBe("accounting");
  });

  /*
    DERIVED FROM THE SERVER, never from local storage. A draft saved in the
    browser would be a second version of the truth that survives somebody else
    finishing the setup — so this must answer from the settings row alone, which
    is what makes "resume" portable and non-contradictory.
  */
  it("reaches the last step only when everything before it is done", () => {
    expect(firstIncompleteStep(CONFIGURED)).toBe("people");
  });

  it("returns to accounting when the credentials are gone but the rest is set", () => {
    /*
      `canAuthorize` goes with them: once nothing is stored and the environment has
      nothing either, the server stops answering true, so the regression is stated
      the way the server states it.
    */
    const regressed = settings({
      ...CONFIGURED,
      adaptor: {
        ...CONFIGURED.adaptor,
        credentials: { configured: false, lastFour: null, unreadable: false },
        canAuthorize: false,
      },
    });
    expect(firstIncompleteStep(regressed)).toBe("accounting");
  });

  /*
    THE SECOND QUESTION, WHICH IS NOT THE FIRST.

    A QuickBooks deployment configured entirely from its environment stores nothing
    and can still authorize — which used to strand it on a step it could never
    complete: it had everything it needed and the console said it had nothing.
  */
  it("passes accounting when QuickBooks resolves the pair from the environment", () => {
    const fromEnvironment = settings({
      ...CONFIGURED,
      adaptor: {
        ...CONFIGURED.adaptor,
        credentials: { configured: false, lastFour: null, unreadable: false },
        canAuthorize: true,
      },
    });
    expect(firstIncompleteStep(fromEnvironment)).toBe("people");
  });

  it("holds accounting when QuickBooks can resolve nothing at all", () => {
    const unresolvable = settings({
      ...CONFIGURED,
      adaptor: {
        ...CONFIGURED.adaptor,
        credentials: { configured: false, lastFour: null, unreadable: false },
        canAuthorize: false,
      },
    });
    expect(firstIncompleteStep(unresolvable)).toBe("accounting");
  });

  /* Sage has no browser authorization, so `canAuthorize` is not evidence about a
     pair that exists — only a stored pair is. */
  it("does not let a Sage deployment skip accounting on canAuthorize alone", () => {
    const sage = settings({
      ...CONFIGURED,
      adaptor: {
        ...CONFIGURED.adaptor,
        id: "sage",
        credentials: { configured: false, lastFour: null, unreadable: false },
        canAuthorize: true,
      },
    });
    expect(firstIncompleteStep(sage)).toBe("accounting");
  });
});

describe("validateOrganizationName", () => {
  it("rejects an empty or whitespace-only name", () => {
    expect(validateOrganizationName("")).not.toBeNull();
    expect(validateOrganizationName("   ")).not.toBeNull();
  });

  it("accepts a reasonable name and rejects an absurd one", () => {
    expect(validateOrganizationName("Northgate Academy")).toBeNull();
    expect(validateOrganizationName("x".repeat(81))).not.toBeNull();
    expect(validateOrganizationName("x".repeat(80))).toBeNull();
  });

  it("measures the trimmed name, not the raw one", () => {
    expect(validateOrganizationName("  Acme  ")).toBeNull();
  });
});

describe("validateGateway", () => {
  it("requires a client id always", () => {
    expect(validateGateway({ clientId: "  ", webhookSecret: "" }, settings()).clientId).toBeDefined();
  });

  /*
    A stored secret is write-only and can never be pre-filled, so demanding it on
    every pass asks the operator for something only the server knows. "Leave it
    blank to keep the stored value" is the only coherent contract, and it is why
    this suite exists.
  */
  it("does not demand a webhook secret that is already stored", () => {
    const errors = validateGateway({ clientId: "gw-1", webhookSecret: "" }, CONFIGURED);
    expect(errors.webhookSecret).toBeUndefined();
  });

  it("does demand one when nothing is stored", () => {
    const errors = validateGateway({ clientId: "gw-1", webhookSecret: "  " }, settings());
    expect(errors.webhookSecret).toBeDefined();
  });
});

describe("validateAccounting", () => {
  const values = (over: Partial<Record<string, string>> = {}) => ({
    clientId: "",
    clientSecret: "",
    baseUrl: "",
    ...over,
  });

  it("refuses to go further with no accounting system chosen", () => {
    expect(validateAccounting(null, values(), settings()).id).toBeDefined();
  });

  it("requires the app credentials while nothing is stored", () => {
    const errors = validateAccounting("quickbooks", values(), settings());
    expect(errors.clientId).toBeDefined();
    expect(errors.clientSecret).toBeDefined();
  });

  it("asks for nothing once credentials are stored — the dead-end this rule closed", () => {
    const errors = validateAccounting("quickbooks", values(), CONFIGURED);
    expect(errors.clientId).toBeUndefined();
    expect(errors.clientSecret).toBeUndefined();
  });

  it("still asks when the stored credentials belong to a DIFFERENT system", () => {
    const onSage: ApiDeploymentSettings = {
      ...CONFIGURED,
      adaptor: { ...CONFIGURED.adaptor, id: "sage" },
    };
    const errors = validateAccounting("quickbooks", values(), onSage);
    expect(errors.clientId).toBeDefined();
  });

  it("accepts a blank optional base URL and rejects a malformed one", () => {
    expect(validateAccounting("quickbooks", values(), CONFIGURED).baseUrl).toBeUndefined();
    expect(validateAccounting("quickbooks", values({ baseUrl: "not a url" }), CONFIGURED).baseUrl).toBeDefined();
  });

  it("rejects a non-http protocol", () => {
    expect(
      validateAccounting("quickbooks", values({ baseUrl: "ftp://example.com" }), CONFIGURED).baseUrl,
    ).toBeDefined();
    expect(
      validateAccounting("quickbooks", values({ baseUrl: "https://example.com" }), CONFIGURED).baseUrl,
    ).toBeUndefined();
  });
});

describe("adaptorChoice", () => {
  it("finds each declared choice and nothing for null", () => {
    for (const choice of ADAPTOR_CHOICES) {
      expect(adaptorChoice(choice.id)?.id).toBe(choice.id);
    }
    expect(adaptorChoice(null)).toBeNull();
  });
});

describe("connectOutcomeFromSearch", () => {
  it("reads a success and carries the realm", () => {
    expect(connectOutcomeFromSearch("?connect=connected&realm=9341")).toEqual({
      connected: true,
      realm: "9341",
      message: null,
    });
  });

  it("accepts the search string with or without the leading question mark", () => {
    expect(connectOutcomeFromSearch("connect=connected").connected).toBe(true);
  });

  it("has copy for every reason the server can send", () => {
    for (const key of Object.keys(CONNECT_FAILURE_COPY)) {
      expect(CONNECT_FAILURE_COPY[key]?.length).toBeGreaterThan(0);
    }
  });

  /*
    The server puts a REASON CODE in the URL, not prose, because a redirect is
    where secrets leak. An unrecognised code must still produce something an
    operator can act on rather than a blank panel.
  */
  it("falls back to default copy for an unknown reason", () => {
    const outcome = connectOutcomeFromSearch("?connect=error&reason=something_new");
    expect(outcome.connected).toBe(false);
    expect(outcome.message).toBe(CONNECT_FAILURE_COPY.default);
  });

  /*
    A deployment with no secrets key can now come back from QuickBooks having
    authorized and saved nothing. It must read as THAT, not as the generic default,
    because the operator's next move is completely different: an administrator has
    to configure the deployment, and no amount of retrying will help. It names the
    limit without naming the variable — the 503 already does that, for the
    administrator who can act on it, and this page is read by operators who can't.
  */
  it("resolves not_writable to its own copy rather than the default", () => {
    const outcome = connectOutcomeFromSearch("?connect=error&reason=not_writable");
    expect(outcome.connected).toBe(false);
    expect(outcome.message).toBe(CONNECT_FAILURE_COPY.not_writable);
    expect(outcome.message).not.toBe(CONNECT_FAILURE_COPY.default);
    expect(outcome.message).not.toContain("SECRETS_KEY");
  });

  /* "Nothing stored" is no longer the only way to have no pair to connect with, so
     the copy must not tell an operator their environment is irrelevant. */
  it("does not blame stored credentials alone when nothing can be resolved", () => {
    const outcome = connectOutcomeFromSearch("?connect=error&reason=no_credentials");
    expect(outcome.message).toBe(CONNECT_FAILURE_COPY.no_credentials);
    expect(outcome.message).toContain("environment");
  });

  it("is a quiet no-op when the marker is absent", () => {
    expect(connectOutcomeFromSearch("")).toEqual({ connected: false, realm: null, message: null });
  });
});
