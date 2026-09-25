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
    label: "Organization",
    title: "Name this organization",
    lead: "One deployment serves one organization, so this is the organization's name — not the server's.",
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
  /**
   * A member of an either/or group, and the field the group's error is reported on.
   * @deprecated Only the transitional env-fallback path still needs this; the
   * QuickBooks form no longer collects tokens, so nothing in the wizard groups.
   */
  group?: "token";
  optional?: boolean;
}

export interface AdaptorChoice {
  id: ApiAdaptorId;
  label: string;
  blurb: string;
  fields: readonly CredentialField[];
  /**
   * True when the operator authorizes this system by signing in at the provider,
   * rather than by pasting a token.
   *
   * WHY THE FORM ASKS FOR SO LITTLE. A client id and secret identify the APP; on
   * their own they cannot authorize anything, because a grant needs a human to
   * consent. That consent is a browser round trip which returns a refresh token the
   * system rotates for as long as it lives — so the operator supplies two values
   * they keep in their provider's developer console, and never types a token again.
   *
   * Which mattered: tokens are write-only once stored, so a deployment whose token
   * needed replacing could only be fixed by retyping values nobody had kept a copy
   * of. The operator's two app credentials can be retyped at any time.
   */
  browserConnect?: boolean;
}

export type AccountingValues = Partial<
  Record<"clientId" | "clientSecret" | "baseUrl", string>
>;

export const ADAPTOR_CHOICES: readonly AdaptorChoice[] = [
  {
    id: "quickbooks",
    label: "QuickBooks Online",
    blurb: "Payments are posted as records in the connected company.",
    browserConnect: true,
    fields: [
      {
        key: "clientId",
        label: "Client ID",
        hint: "From your Intuit developer app. Identifies the application, not the company.",
      },
      {
        key: "clientSecret",
        label: "Client secret",
        secret: true,
        hint: "Used server-side to exchange the grant for tokens. It never leaves the server.",
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
  const nothingStored = !(settings.adaptor.id === id && settings.adaptor.credentials.configured);

  /*
    A FIELD IS REQUIRED ONLY WHEN NOTHING IS STORED FOR IT.

    This is the rule that was missing, and it is what made the wizard a dead end.
    A stored secret is write-only and can never be pre-filled, so demanding it on
 * every pass asked the operator for a value they had no way to read — the screen
    was asking for something only the server knew. "Leave it blank to keep the
    stored value" is the only coherent contract here, and the gateway secret has
    worked that way since it was written.
  */
  for (const field of choice.fields) {
    if (field.optional || field.group) continue;
    if (nothingStored && valueOf(field.key).length === 0) {
      errors[field.key] = `${field.label} is required.`;
    }
  }

  /*
    Everything downstream of consent — the tokens, the company, the grant — comes
    back from the provider, so none of it is something the operator can be asked for.
    Only the app credentials are, and only while there are none stored.
  */

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

/**
 * What the connect attempt resulted in, from the `?connect=` marker the provider
 * callback redirects back with.
 *
 * The server puts a REASON code in the URL, not prose, for the same reason it never
 * puts a token there: a redirect is a place secrets and provider detail leak. The
 * wording an operator reads is chosen here, where it can be reviewed, rather than
 * being assembled from whatever the provider happened to send.
 */
export const CONNECT_FAILURE_COPY: Record<string, string> = {
  unverified: "That connection could not be verified, so nothing was saved. Start the connection again.",
  declined: "Authorization was cancelled at QuickBooks, so nothing was saved.",
  no_code: "QuickBooks did not return an authorization. Start the connection again.",
  no_credentials:
    "This deployment has no client ID and client secret stored, so there is nothing to connect with.",
  exchange_failed:
    "QuickBooks rejected the authorization. Check the client ID and client secret belong to the same app, and that the redirect URI is registered with it.",
  default: "The connection did not complete, so nothing was saved. Start again from this page.",
};

export function connectOutcomeFromSearch(search: string): {
  connected: boolean;
  realm: string | null;
  message: string | null;
} {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const status = params.get('connect');
  const realm = params.get('realm');
  if (status === 'connected') {
    return { connected: true, realm, message: null };
  }
  if (status === 'error') {
    const reason = params.get('reason') ?? 'default';
    return {
      connected: false,
      realm: null,
      message: CONNECT_FAILURE_COPY[reason] ?? CONNECT_FAILURE_COPY['default']!,
    };
  }
  return { connected: false, realm: null, message: null };
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
