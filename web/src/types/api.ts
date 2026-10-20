/* Frontend API types — mirror the backend domain shapes (server/src/models/domain.ts)
   exactly so the mapping layer can translate them into the frontend's display types
   (types/domain.ts). These carry NO financial amounts, NO customer PII, and NO
   raw card data — only operational lifecycle events, connector states, and reference
   hashes (FR-2.3 / FR-5.2). */

export type ConnectorTerminus = "quickbooks" | "sage" | "amber-pay" | "audit-trail";
export type ConnectorStatus = "open" | "arriving" | "delayed" | "suspended";

export interface ConnectorState {
  id: string;
  organizationId: string;
  label: string;
  terminus: ConnectorTerminus;
  status: ConnectorStatus;
  reading: string;
  note: string;
}

export type LifecycleEventType =
  | "initiated"
  | "collected"
  | "record-updated"
  | "sync-change"
  | "webhook-received"
  | "payment-declined"
  | "payment-failed"
  | "payment-refunded"
  // Adaptor reachability is part of the lifecycle log: "the accounting link is
  // down" and "a payment never reached the ledger" are one story.
  | "adaptor-unreachable"
  | "adaptor-auth-failed"
  | "adaptor-restored";

export type LifecycleChannel = "payment" | "accounting" | "webhook" | "system";

export interface ApiLifecycleEvent {
  id: string;
  organizationId: string;
  at: string;
  type: LifecycleEventType;
  channel: LifecycleChannel;
  ref: string;
  detail: string;
}

export type Severity = "critical" | "attention";

export interface ApiFailure {
  id: string;
  organizationId: string;
  severity: Severity;
  channel: LifecycleChannel;
  title: string;
  detail: string;
  since: string;
  acknowledgedAt?: string;
  /**
   * Email of the operator who acknowledged. ABSENT for findings acknowledged
   * before attribution existed — the server writes null rather than inventing
   * an actor, so the console must render a genuinely unknown actor instead of
   * guessing or leaving a blank that reads as "unacknowledged".
   */
  acknowledgedBy?: string;
}

/** POST /failures/acknowledge */
export interface ApiAcknowledgeFailuresResponse {
  /** How many findings were actually acknowledged — not how many were sent. */
  acknowledged: number;
  failures: ApiFailure[];
}

/* ---------------------------------------------------------- stage flow */

export type FlowStage = "initiated" | "collected" | "ingested" | "posted";

export type StageState = "healthy" | "degraded" | "failed" | "not-reporting";

export interface StageThresholds {
  warnMs: number;
  failMs: number;
}

export interface ApiStageFlow {
  stage: FlowStage;
  state: StageState;
  entered: number;
  inFlight: number;
  exited: number;
  completed: number;
  failed: number;
  oldestInFlightAt: string | null;
  dwellP95Ms: number | null;
  sampleSize: number;
  thresholds: StageThresholds;
  notReporting: boolean;
}

export interface ApiStageFlowSummary {
  stages: ApiStageFlow[];
  trackedRefs: number;
  oldestInFlightAt: string | null;
  failedRefs: number;
  window: { from: string | null; to: string | null };
  eventsConsidered: number;
  mayBeTruncated: boolean;
  computedAt: string;
}

export interface ApiPolicyScope {
  id: string;
  label: string;
  attributes: Record<string, string>;
  readOnly: boolean;
}

/** Shape returned by GET /api/v1/dashboard/metrics. */
export interface MetricsResponse {
  connectors: ConnectorState[];
  events: ApiLifecycleEvent[];
  failures: ApiFailure[];
  policies: ApiPolicyScope[];
  /** Authoritative flow aggregate; absent from older server builds. */
  stages?: ApiStageFlowSummary;
  generatedAt: string;
}

/* ------------------------------------------------------ service status */

export interface ApiAdaptorStatus {
  id: string;
  name: string;
  status: string;
  reachable: boolean;
  latencyMs: number | null;
  message?: string;
}

export interface ApiServiceStatus {
  service: {
    name: string;
    version: string;
    environment: string;
    nodeVersion: string;
    startedAt: string;
    uptimeSeconds: number;
    storage: string;
    eventWindowLimit: number;
    rows: { connectors: number | null; failures: number | null };
    adaptors: ApiAdaptorStatus[];
  };
  generatedAt: string;
}

/* -------------------------------------------------- identity & access */

export type PolicyAction = "read" | "ack" | "write" | "admin";

/** A PBAC grant: `actions` on `scope` within `organizationId`. `*` is wildcard. */
export interface ApiPolicyAttribute {
  scope: string;
  organizationId: string;
  actions: PolicyAction[];
}

/**
 * The caller's own identity (GET /auth/me).
 *
 * `email` is present because `User` is the ONE entity in this product allowed
 * to hold an email address — it is a sign-in identity, never customer PII
 * (FR-2.3). Nothing else about the account is exposed.
 */
export interface ApiIdentity {
  id: string;
  email: string;
  policyAttributes: ApiPolicyAttribute[];
  policies: ApiPolicyScope[];
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * When the first-run guided tour was finished or skipped, or `null` when this
   * account has never been offered it. The console starts the tour only on
   * `null` — the claim is about the account, not the browser, so a second device
   * does not re-tour the same person.
   */
  tourCompletedAt: string | null;
  /**
   * The name of the organization this deployment serves, or null before setup
   * has been finished. Present here rather than on `/settings` because it is
   * deployment-wide identity — it appears in every page header — and `/settings`
   * requires the `system` scope an ordinary operator does not hold.
   */
  organizationName: string | null;
  /** When the current access token stops working (ISO 8601). */
  tokenExpiresAt: string;
}

/**
 * What an outstanding invite carries (GET /auth/invite/:token).
 *
 * No id, no timestamps and no token hash: the accept page needs the address it
 * is inviting and the access it is offering, and nothing else about the invite
 * is any of its business.
 */
export interface ApiInviteDetail {
  email: string;
  policyAttributes: ApiPolicyAttribute[];
  /** When the link stops working (ISO 8601). */
  expiresAt: string;
}

/**
 * One row of the administrator's user directory (GET /users).
 *
 * `invite-pending` means no account exists yet — only an outstanding invite.
 * `id` is the account id for active rows and the invite id for pending ones,
 * which is what the resend action addresses.
 */
export interface ApiDirectoryUser {
  id: string;
  email: string;
  status: "active" | "invite-pending";
  policyAttributes: ApiPolicyAttribute[];
  organizations: string[];
  createdAt: string;
  updatedAt: string;
  inviteExpiresAt?: string;
}

/* ------------------------------------------------ deployment configuration */

/** The one accounting system a deployment integrates with. */
export type ApiAdaptorId = "quickbooks" | "sage";

/**
 * Where a payment's identifier is found on a QuickBooks customer.
 *
 * NOT interchangeable in cost, and only ONE of them is a single call. Verified
 * against a live QuickBooks company on 2026-09-28: a `DisplayName` filter is
 * accepted, while both `Notes like` and a custom-field filter are answered with
 * HTTP 400 — the provider cannot search either. The other two therefore read
 * customers a page at a time, which is metered against its rate limit and
 * bounded, and the console says so before an operator chooses.
 */
export type ApiInvoiceMatchStrategy = "displayName" | "customField" | "notes";

/** `Match` is `contains` when a fragment can match more than one customer. */
export type ApiInvoiceMatchMode = "exact" | "contains";

/**
 * The currency codes the gateway documents. Anything else is refused at the
 * boundary rather than passed through and rejected upstream.
 */
export type ApiGatewayCurrency = "USD" | "JMD";

/**
 * What `POST /payments` returns: a place to POST and the parameters to post.
 *
 * NOT a link. The gateway issues no URL a customer visits — it expects a signed
 * POST and answers with the payment form. The browser posts directly to
 * `checkoutUrl`, which is the point: card details go to the gateway and never
 * reach this application.
 */
export interface ApiCheckoutParams {
  ClientId: string;
  TransactionId: string;
  CurrencyCode: ApiGatewayCurrency;
  /** Minor units — 25000 is 250.00. */
  Amount: number;
  Signature: string;
  /** The customer this payment is for. */
  CustomerReference: string;
  CustomerInvoice: "Y" | "N";
  ReturnToMerchant: "Y" | "N";
  AutoRedirect: "Y" | "N";
}

export interface ApiCheckoutSession {
  checkoutUrl: string;
  params: ApiCheckoutParams;
  transactionId: string;
  /** True when fabricated locally. Never in production. */
  simulated?: boolean;
}

/**
 * The payment as the API returns it: operational status and reference only.
 *
 * `transactionId` is the reference the gateway echoes, which is what makes this
 * resolvable by a customer coming back from the gateway — the uuid is ours and
 * was never shown to anybody.
 */
export interface ApiPayment {
  id: string;
  invoiceId: string;
  organizationId: string;
  transactionId: string;
  status: "initiated" | "collected" | "failed" | "refunded";
  processedAt: string;
  /**
   * MAJOR units as a decimal string ("250.00"), never a number.
   *
   * Optional because the original payment entity deliberately carried no
   * figure, and a deployment that predates refunds will not send one. The
   * refund dialog reads it as the ceiling for a partial refund and offers full
   * only when it is absent — it never guesses a figure.
   */
  amount?: string | null;
  /**
   * The original charge under the name a refund-aware read may use. Kept as an
   * alias of `amount` rather than a second concept: the dialog reads
   * `amount ?? originalAmount` and there is only ever one original figure.
   */
  originalAmount?: string | null;
  /** ISO 4217 code the amount is denominated in, when the API reports it. */
  currency?: string | null;
  /** Present once a refund has been recorded, when the API reports it. */
  refundedAt?: string | null;
  /** The refunded figure in MAJOR units, when the API reports it. */
  refundAmount?: string | null;
}

/**
 * The record `POST /payments/:id/refund` returns alongside the updated payment.
 *
 * Only the fields the console can display are declared. The server may return
 * more; nothing here is required, because the authoritative refunded state is
 * `payment.status === "refunded"` — this is the receipt for the one refund that
 * was just made, and a reload must not depend on having it.
 */
export interface ApiRefund {
  /** Whether the whole charge, or part of it, was returned. */
  scope?: "full" | "partial";
  /**
   * What happened in the accounting system AFTER the money moved. `failed` and
   * `manual-adjustment-required` are both "the refund succeeded, the books did
   * not" — the distinction is who has to finish the job, not whether money
   * moved, so neither may be presented as a failed refund.
   */
  accountingReversal?: "reversed" | "manual-adjustment-required" | "failed" | "not-configured";
  /** The server's explanation when the books still need a person. */
  message?: string;
  /* The local refund record, when the API sends one. Optional because the
     authoritative refunded state is `payment.status`, and a reload must not
     depend on this receipt. */
  id?: string;
  paymentId?: string;
  /** MAJOR units as a decimal string. */
  amount?: string;
  currency?: string;
  refundedAt?: string;
}

/**
 * What a read may say about a stored secret: whether one exists, and its last four
 * characters. NEVER the value.
 *
 * `unreadable` is its own fact rather than a flavour of `configured: false`,
 * because "no credential" and "a credential this deployment cannot decrypt" call
 * for opposite actions from an operator.
 */
export interface ApiCredentialPresence {
  configured: boolean;
  lastFour: string | null;
  unreadable: boolean;
}

/**
 * The deployment's configuration as the API is willing to describe it
 * (GET /settings).
 */
export interface ApiDeploymentSettings {
  /**
   * The deployment's organization identity, read from the server's environment.
   * Deliberately not editable: two copies of an identity are two chances to
   * disagree, and a mismatch makes every stored row invisible to the users it is
   * about, with no error anywhere.
   */
  organizationId: string;
  organizationName: string | null;
  gateway: {
    clientId: string | null;
    webhookSecret: ApiCredentialPresence;
  };
  adaptor: {
    id: ApiAdaptorId | null;
    realmId: string | null;
    baseUrl: string | null;
    credentials: ApiCredentialPresence;
    /**
     * Whether this deployment can OBTAIN AND KEEP a provider authorization: the
     * client id and client secret resolve — from the stored settings or from the
     * deployment's own environment — and a granted authorization could be saved.
     *
     * NOT THE SAME QUESTION AS `credentials.configured`. That asks whether a pair
     * is stored; this asks whether the server can act on one. So a deployment
     * configured entirely from its environment answers true with nothing stored,
     * and false now means either "nothing to connect with" or "nowhere to save the
     * result" — `writable` is what separates those two.
     *
     * Presence of named fields, never values — the browser needs this to avoid
     * offering a button the server will refuse.
     */
    canAuthorize: boolean;
    /**
     * The customer matching rule, or all-null when none is set.
     *
     * READABLE BY ANYONE WHO CAN READ THIS PAGE, writable only by an
     * administrator. The split is deliberate and it is not symmetric: seeing the
     * rule is how an operator tells whether a payment is being matched to the
     * right student, while changing it is how money gets steered. So a reader
     * sees the same field an admin edits, and gets no control.
     */
    invoiceMatching: {
      strategy: ApiInvoiceMatchStrategy | null;
      mode: ApiInvoiceMatchMode | null;
      fieldName: string | null;
      depositAccountId: string | null;
    };
  };
  syncInterval: string | null;
  alertTarget: string | null;
  /** When the connection was last proven to work; cleared by a credential change. */
  verifiedAt: string | null;
  /** When setup was finished. Null until then — this IS the first-run flag. */
  configuredAt: string | null;
  configured: boolean;
  /**
   * False when the deployment has no encryption key. The API starts without one
   * (an upgrade must not take a working install offline) but refuses to store
   * credentials, so the wizard has to say so before an operator fills a form in.
   */
  writable: boolean;
}

/** Why a connection attempt failed, as a value rather than a sentence. */
export type ApiAdaptorFailureReason = "auth" | "rate-limited" | "unreachable" | "upstream";

/**
 * The verdict of a connection test (POST /settings/adaptor/verify).
 *
 * A FAILED test is a normal 200 carrying `ok: false` and a `reason` — a rejected
 * credential is the expected result of an operator typing one, not a transport
 * error, and the `reason` is what lets the screen say "fix the value" instead of
 * "try again later".
 *
 * There is deliberately no rotated-credential field: the server persists one and
 * never returns it, so this client cannot hold a secret it did not type.
 */
export interface ApiAdaptorVerification {
  ok: boolean;
  adaptorId: ApiAdaptorId;
  latencyMs: number;
  message: string;
  reason: ApiAdaptorFailureReason | null;
}