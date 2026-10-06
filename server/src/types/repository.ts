import type {
  ConnectorState,
  Failure,
  LifecycleEvent,
  Payment,
  ReconciliationJob,
} from '../models/domain.js';
import type { DeploymentSettings, DeploymentSettingsPatch } from '../models/deploymentSettings.js';
import type { AuthUser, Invite, PasswordReset, PolicyAttribute, TwoFactorChallenge } from './auth.js';

/**
 * Persistence contracts. Each repository has a Postgres implementation and an
 * in-memory implementation (used in tests and as a fallback when no DB is
 * configured). All methods are async so the Postgres implementation can do
 * real I/O while the in-memory one resolves immediately.
 */

export interface UserRepository {
  create(
    email: string,
    hashedPassword: string,
    policyAttributes: PolicyAttribute[],
  ): Promise<AuthUser>;
  findByEmail(email: string): Promise<AuthUser | undefined>;
  findById(id: string): Promise<AuthUser | undefined>;
  /** All accounts, ordered by email. Backs the admin user directory. */
  list(): Promise<AuthUser[]>;
  /**
   * Replace a user's PBAC attributes. Returns the updated user, or undefined
   * when no account matches `id`.
   */
  updatePolicyAttributes(
    id: string,
    policyAttributes: PolicyAttribute[],
  ): Promise<AuthUser | undefined>;
  /** Replace a user's password hash. Returns false when no account matches. */
  updatePassword(id: string, hashedPassword: string): Promise<boolean>;
  /**
   * Stamp first-run tour completion.
   *
   * Idempotent and race-safe: the stamp is applied only when the account has
   * none, so two concurrent calls cannot both write and a replay can never
   * rewrite the original timestamp.
   *
   * @returns `true` when THIS call applied the stamp, `false` when the account
   * is absent or was already stamped. Callers treat both as success — the
   * endpoint is deliberately idempotent — so the flag is for logging and tests,
   * not control flow.
   */
  markTourCompleted(id: string, at: string): Promise<boolean>;
}

export interface InviteRepository {
  create(invite: Invite): Promise<Invite>;
  findByTokenHash(tokenHash: string): Promise<Invite | undefined>;
  markAccepted(id: string, acceptedAt: string): Promise<void>;
  /** All invites, newest first. Backs the admin user directory's pending rows. */
  list(): Promise<Invite[]>;
}

export interface PasswordResetRepository {
  create(reset: PasswordReset): Promise<PasswordReset>;
  findByTokenHash(tokenHash: string): Promise<PasswordReset | undefined>;
  /**
   * Atomically redeem a token, returning the owning user id, or `undefined`
   * when the token is unknown, already used, or expired.
   *
   * The check and the mark MUST be one operation. Reading `usedAt`, hashing a
   * password (bcrypt, cost 12 = hundreds of ms) and only then stamping `usedAt`
   * left a window in which two concurrent requests redeemed the same link and
   * both wrote a password — the last writer took the account.
   */
  consume(tokenHash: string, usedAt: string): Promise<string | undefined>;
  /** Invalidate every outstanding reset for a user (a new request supersedes). */
  invalidateForUser(userId: string, usedAt: string): Promise<void>;
}


export interface TwoFactorRepository {
  create(challenge: TwoFactorChallenge): Promise<TwoFactorChallenge>;
  findById(id: string): Promise<TwoFactorChallenge | undefined>;
  /**
   * Spend one verification attempt, returning the new count, or `undefined`
   * when the challenge is already consumed or has NO attempts left.
   *
   * The cap is enforced inside the update on purpose: reading `attempts`,
   * comparing it to the limit and then incrementing let concurrent requests
   * each observe a count below the limit and overshoot it, so a 6-digit code
   * could be brute-forced faster than the limit implies.
   */
  spendAttempt(id: string, maxAttempts: number): Promise<number | undefined>;
  /**
   * Atomically mark the challenge used. Returns true only for the caller that
   * performed the transition, so a second concurrent verification cannot also
   * be treated as successful.
   */
  consume(id: string): Promise<boolean>;
}

/**
 * Every list/read method accepts an `organizationIds` filter so callers can
 * restrict results to the organizations they are authorized for (C1). The
 * Postgres implementation enforces this with `WHERE organization_id = ANY($1)`;
 * the in-memory implementation filters in JS. Passing an empty array returns
 * no rows. Passing `null` means "all organizations" (used for a wildcard /
 * super-admin caller) and returns all rows.
 *
 * ORDERING/LIMITS (M1): the in-memory implementations mirror the Postgres
 * ordering and limits exactly so tests observe the same shapes as production:
 * - `EventRepository.list`  -> ORDER BY at DESC LIMIT 500
 * - `FailureRepository.list`-> ORDER BY since DESC LIMIT 500
 * - `ReconciliationRepository.list` -> ORDER BY run_at DESC LIMIT 100
 * - `ConnectorStateRepository.list` -> ORDER BY id
 */
export interface EventRepository {
  append(event: LifecycleEvent): Promise<LifecycleEvent>;
  list(organizationIds: string[] | null): Promise<LifecycleEvent[]>;
}

export interface FailureRepository {
  append(failure: Failure): Promise<Failure>;
  list(organizationIds: string[] | null): Promise<Failure[]>;
  acknowledge(
    id: string,
    acknowledgedAt: string,
    organizationIds: string[] | null,
    acknowledgedBy?: string,
  ): Promise<Failure | undefined>;
  /**
   * Acknowledge many findings as ONE operator action (FR-5.3).
   *
   * The batch deliberately takes a single `acknowledgedAt` and a single
   * `acknowledgedBy`: the caller clicked once and means once. Giving each id
   * its own timestamp would fabricate a sequence of separate observations
   * that did not happen.
   *
   * Resolves to the rows ACTUALLY acknowledged, not a count. Ids outside the
   * caller's authorized organizations are skipped rather than treated as an
   * error — a batch must not fail wholesale because one id belongs to another
   * tenant, and an id the caller may not see must not be distinguishable from
   * one that does not exist. The controller passes the authorized set derived
   * from the token; this layer enforces it.
   */
  acknowledgeMany(
    ids: string[],
    acknowledgedAt: string,
    organizationIds: string[] | null,
    acknowledgedBy?: string,
  ): Promise<Failure[]>;
}

/**
 * How long a claim is honoured before another delivery may take it over.
 * A process that dies between `claim` and `markProcessed`/`release` would
 * otherwise leave the id claimed forever, so the transaction would never be
 * pushed to accounting. This is the recovery window for that case.
 */
export const WEBHOOK_CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Webhook idempotency and replay defence (M2).
 *
 * `claim` is the atomic gate and the whole point of this contract. It reports
 * whether THIS caller now owns the id, and it succeeds only when:
 * - the id has never been seen, or
 * - a previous claim was released after a failure, or
 * - a previous claim is older than `WEBHOOK_CLAIM_LEASE_MS` (the claimant died).
 *
 * It FAILS for an id that is already processed, or that another delivery is
 * processing right now. That combination is what the earlier
 * "check-processed, then mark-processing" pair could not express: it left a
 * window in which two concurrent deliveries both proceeded, and it also let a
 * replay of an already-processed event through whenever the first attempt had
 * not finished.
 */
export interface WebhookDedupRepository {
  /** Atomically take ownership of `id`. False means duplicate or replay. */
  claim(id: string, processedAt: string): Promise<boolean>;
  /** Record success. The id is now permanently deduplicated. */
  markProcessed(id: string, processedAt: string): Promise<void>;
  /**
   * Give the claim back after a failure so the sender's retry is processed.
   * Deliberately indistinguishable from "never seen" — a released delivery
   * left no success behind, and must not be reported as one.
   */
  release(id: string): Promise<void>;
}

export interface ReconciliationRepository {
  create(job: ReconciliationJob): Promise<ReconciliationJob>;
  list(organizationIds: string[] | null): Promise<ReconciliationJob[]>;
}

export interface ConnectorStateRepository {
  upsert(state: ConnectorState): Promise<ConnectorState>;
  list(organizationIds: string[] | null): Promise<ConnectorState[]>;
}

export interface PaymentRepository {
  create(payment: Payment): Promise<Payment>;
  findById(id: string, organizationIds: string[] | null): Promise<Payment | undefined>;
  /**
   * Find by the TRANSACTION id the gateway echoed, org-scoped like every other
   * read.
   *
   * Distinct from `findById` because the two identifiers have different
   * audiences: the uuid is ours and never leaves this origin, while the
   * transaction id is the one value a customer can carry back from the gateway.
   */
  findByTransactionId(
    transactionId: string,
    organizationIds: string[] | null,
  ): Promise<Payment | undefined>;
}

/** Container of every repository, wired by the factory. */
export interface Repositories {
  users: UserRepository;
  invites: InviteRepository;
  twoFactor: TwoFactorRepository;
  passwordResets: PasswordResetRepository;
  events: EventRepository;
  failures: FailureRepository;
  webhookDedup: WebhookDedupRepository;
  reconciliation: ReconciliationRepository;
  connectorStates: ConnectorStateRepository;
  payments: PaymentRepository;
  settings: SettingsRepository;
}

/**
 * Configuration for the single organization this deployment serves.
 *
 * ONE ROW, and there is no `create` or `delete`: the row is materialised by the
 * migration, so `get()` can never fail for absence and no caller has to decide
 * whether a missing row means "unconfigured" or "not installed".
 */
export interface SettingsRepository {
  get(): Promise<DeploymentSettings>;
  /**
   * Merge a patch into the row. A key present as `null` CLEARS that field; an
   * absent key leaves it alone (see `DeploymentSettingsPatch`).
   */
  update(patch: DeploymentSettingsPatch): Promise<DeploymentSettings>;
}
