/* The rules the onboarding wizard and the configuration page share.
 *
 * ONE COPY, because the wizard will not be the only client for long: the console's
 * System configuration page reads the same settings, and a second opinion on "what
 * counts as a valid gateway client id" is a second answer that eventually disagrees
 * with the first. The SERVER enforces every one of these too — validation belongs at
 * the boundary every write crosses — so this layer exists to tell an operator before
 * a round trip, not to be the boundary itself.
 */

import type {
  ApiAdaptorFailureReason,
  ApiAdaptorId,
  ApiAdaptorVerification,
  ApiDeploymentSettings,
  ApiPolicyAttribute,
} from "@/types/api";

/* ------------------------------------------------------------ the steps */

export type WizardStepId = "organization" | "gateway" | "accounting" | "verify" | "people";

export interface WizardStep {
  id: WizardStepId;
  /** The stepper's own label: two words at most, or the row wraps at 720px. */
  label: string;
  title: string;
  lead: string;
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: "organization",
    label: "This deployment",
    title: "Confirm what this deployment is",
    lead: "Give it a name your team will recognise, and check the organization it serves.",
  },
  {
    id: "gateway",
    label: "Gateway",
    title: "Connect to Amber Pay",
    lead: "These are the gateway credentials that let payments reach this deployment.",
  },
  {
    id: "accounting",
    label: "Accounting",
    title: "Choose the one accounting system",
    lead: "This deployment integrates with a single accounting system. Everything the console shows is filtered to it.",
  },
  {
    id: "verify",
    label: "Test",
    title: "Prove the connection works",
    lead: "One round trip to the accounting system, using the credentials just saved. Nothing is recorded if it fails.",
  },
  {
    id: "people",
    label: "People",
    title: "Invite the first people",
    lead: "Access is invitation-only. Anyone you add here receives a link to choose their own password.",
  },
];

export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEPS.findIndex((step) => step.id === id);
}

export function stepAt(index: number): WizardStep {
  const clamped = Math.min(Math.max(index, 0), WIZARD_STEPS.length - 1);
  return WIZARD_STEPS[clamped]!;
}

/**
 * Where a half-finished setup should resume.
 *
 * DERIVED FROM THE SERVER, never from local storage. What this deployment actually
 * has configured is the honest answer to "where was I", it is the same answer from
 * another browser, and it cannot disagree with the row the wizard is writing to.
 * A saved draft in the browser would be a second version of the truth that survives
 * a change made by somebody else.
 */
export function firstIncompleteStep(settings: ApiDeploymentSettings): WizardStepId {
  if (!settings.organizationName) return "organization";
  if (!settings.gateway.clientId || !settings.gateway.webhookSecret.configured) return "gateway";
  if (!settings.adaptor.id || !settings.adaptor.credentials.configured) return "accounting";
  if (!settings.verifiedAt) return "verify";
  return "people";
}

/* ---------------------------------------------------- accounting systems */

export interface CredentialField {
  key: keyof AccountingValues;
  label: string;
  hint?: string;
  /** Rendered as a password field with a reveal control, and never pre-filled. */
  secret?: boolean;
  /**
   * A member of an either/or group, and the field the group's error is reported on.
   * QuickBooks needs a client id and secret to identify the app but a TOKEN to
   * authorize a call, and the adaptor's own error names that distinction — so the
   * form names it too, before a round trip.
   */
  group?: "token";
  optional?: boolean;
}

export interface AdaptorChoice {
  id: ApiAdaptorId;
  label: string;
  blurb: string;
  fields: readonly CredentialField[];
}

export type AccountingValues = Partial<
  Record<"clientId" | "clientSecret" | "realmId" | "baseUrl" | "accessToken" | "refreshToken", string>
>;

export const ADAPTOR_CHOICES: readonly AdaptorChoice[] = [
  {
    id: "quickbooks",
    label: "QuickBooks Online",
    blurb: "Payments are posted as records in the connected company.",
    fields: [
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      {
        key: "realmId",
        label: "Company ID",
        hint: "QuickBooks calls this the realm. It is the company the credentials are scoped to.",
      },
      {
        key: "accessToken",
        label: "Access token",
        secret: true,
        group: "token",
        hint: "Valid for about an hour. Provide this or a refresh token, not necessarily both.",
      },
      {
        key: "refreshToken",
        label: "Refresh token",
        secret: true,
        group: "token",
        hint: "Lets the API keep the access token current by itself.",
      },
      { key: "baseUrl", label: "API base URL", optional: true, hint: "Leave blank unless you use a sandbox." },
    ],
  },
  {
    id: "sage",
    label: "Sage Accounting",
    blurb: "Payments are posted to the connected Sage company.",
    fields: [
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "baseUrl", label: "API base URL", optional: true, hint: "Leave blank unless you use a sandbox." },
    ],
  },
];

export function adaptorChoice(id: ApiAdaptorId | null): AdaptorChoice | null {
  return ADAPTOR_CHOICES.find((choice) => choice.id === id) ?? null;
}

/* ----------------------------------------------------------- validation */

export function validateOrganizationName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Give this deployment a name — it appears on every page header.";
  if (trimmed.length > 80) return "Keep the name under 80 characters.";
  return null;
}

export interface GatewayValues {
  clientId: string;
  webhookSecret: string;
}

/**
 * `webhookSecret` is only required when none is stored yet.
 *
 * The API distinguishes an ABSENT field (leave it alone) from an explicit null
 * (clear it), which is what makes this possible: re-entering the wizard must not
 * force an operator to retype a secret they cannot read back, and must not clear
 * one by leaving the box empty.
 */
export function validateGateway(
  values: GatewayValues,
  settings: ApiDeploymentSettings,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (values.clientId.trim().length === 0) {
    errors["clientId"] = "The gateway client id is required.";
  }
  if (values.webhookSecret.trim().length === 0 && !settings.gateway.webhookSecret.configured) {
    errors["webhookSecret"] = "The webhook secret is required — without it this deployment refuses every delivery.";
  }
  return errors;
}

export function validateAccounting(
  id: ApiAdaptorId | null,
  values: AccountingValues,
  settings: ApiDeploymentSettings,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const choice = adaptorChoice(id);
  if (!choice) {
    errors["id"] = "Choose the accounting system this deployment integrates with.";
    return errors;
  }

  const valueOf = (key: keyof AccountingValues): string => (values[key] ?? "").trim();
  const stored =
    settings.adaptor.id === id && settings.adaptor.credentials.configured
      ? "This deployment already has stored credentials for it."
      : null;

  for (const field of choice.fields) {
    if (field.optional || field.group) continue;
    if (valueOf(field.key).length === 0) {
      errors[field.key] = stored ?? `${field.label} is required.`;
    }
  }

  // The either/or group, reported once on its first member.
  const tokenFields = choice.fields.filter((field) => field.group === "token");
  if (tokenFields.length > 0 && tokenFields.every((field) => valueOf(field.key).length === 0)) {
    const first = tokenFields[0]!;
    errors[first.key] =
      stored ??
      "Provide an access token or a refresh token — a client id and secret alone cannot authorize a call.";
  }

  const baseUrl = valueOf("baseUrl");
  if (baseUrl.length > 0) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        errors["baseUrl"] = "Use an http or https URL.";
      }
    } catch {
      errors["baseUrl"] = "Enter a full URL, including https://";
    }
  }

  return errors;
}

/* ------------------------------------------------------ verification copy */

export interface VerificationReading {
  ok: boolean;
  headline: string;
  detail: string;
}

/**
 * The verdict in the operator's language.
 *
 * A CLASSIFIED `reason`, not a scraped message: the API already distinguishes a
 * rejection from a timeout from a rate limit, and re-deriving that here from the
 * provider's prose would break the first time somebody reworded a message. The
 * adaptor's own sentence is carried along as the detail, because it is written to be
 * read and it names the specific field that is missing.
 */
export function readingForVerification(result: ApiAdaptorVerification): VerificationReading {
  if (result.ok) {
    return {
      ok: true,
      headline: "Connected",
      detail: `The accounting system accepted these credentials and answered in ${result.latencyMs} ms.`,
    };
  }
  const byReason: Record<ApiAdaptorFailureReason, { headline: string; detail: string }> = {
    auth: {
      headline: "The provider rejected these credentials",
      detail:
        "It answered, but refused the authorization. Check the client id and secret, and that the token belongs to this company.",
    },
    "rate-limited": {
      headline: "The provider is limiting requests",
      detail: "Too many attempts in a short window. Wait a minute, then test again.",
    },
    unreachable: {
      headline: "The provider could not be reached",
      detail: `No answer after ${result.latencyMs} ms. Check the API base URL, and that this deployment can reach the internet.`,
    },
    upstream: {
      headline: "The provider answered with an error",
      detail: "It responded, but not with a usable answer about these credentials.",
    },
  };
  const reading = byReason[result.reason ?? "upstream"];
  return { ok: false, ...reading, detail: `${reading.detail} ${result.message}`.trim() };
}

/* ------------------------------------------------------------ first people */

export interface InvitePreset {
  id: "operator" | "administrator";
  label: string;
  blurb: string;
  attributesFor: (organizationId: string) => ApiPolicyAttribute[];
}

/**
 * Two grants, expressed in the product's own vocabulary.
 *
 * The organization is DERIVED from what this deployment serves (D1) rather than
 * typed, so an invite cannot name an organization no row belongs to — which is the
 * failure that makes a new user's console read empty over a healthy backend.
 */
export const INVITE_PRESETS: readonly InvitePreset[] = [
  {
    id: "operator",
    label: "Operator",
    blurb: "Watches the pipeline and acknowledges findings. Cannot change configuration.",
    attributesFor: (organizationId) => [
      { scope: "dashboard", organizationId, actions: ["read", "ack"] },
    ],
  },
  {
    id: "administrator",
    label: "Administrator",
    blurb: "Everything an operator has, plus managing people and this deployment's configuration.",
    attributesFor: (organizationId) => [
      { scope: "dashboard", organizationId, actions: ["read", "ack"] },
      { scope: "users", organizationId, actions: ["admin"] },
      { scope: "system", organizationId, actions: ["write"] },
    ],
  },
];

export function validateInviteEmail(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Enter the email address to invite.";
  // Deliberately loose: an address is the mail server's to judge, and a clever
  // pattern here rejects real addresses at the edge where nobody can override it.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "That does not look like an email address.";
  }
  return null;
}
