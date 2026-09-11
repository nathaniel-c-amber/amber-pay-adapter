import type {
  ConnectorState,
  Failure,
  LifecycleEvent,
  Payment,
  ReconciliationJob,
} from '../domain/types.js';
import type { AuthUser, Invite, PolicyAttribute, TwoFactorChallenge } from '../auth/types.js';

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
}

export interface InviteRepository {
  create(invite: Invite): Promise<Invite>;
  findByTokenHash(tokenHash: string): Promise<Invite | undefined>;
  markAccepted(id: string, acceptedAt: string): Promise<void>;
}

export interface TwoFactorRepository {
  create(challenge: TwoFactorChallenge): Promise<TwoFactorChallenge>;
  findById(id: string): Promise<TwoFactorChallenge | undefined>;
  /** Increment the attempt counter and return the new value. */
  incrementAttempts(id: string): Promise<number>;
  consume(id: string): Promise<void>;
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
  ): Promise<Failure | undefined>;
}

/**
 * Two-phase webhook dedup (M2): a webhook is marked `processing` before it is
 * handled and only flipped to `processed` once it succeeds. `hasProcessed`
 * returns true ONLY for fully-processed webhooks, so a failed webhook (left in
 * `processing`) is retried on the next delivery.
 */
export interface WebhookDedupRepository {
  hasProcessed(id: string): Promise<boolean>;
  markProcessing(id: string, processedAt: string): Promise<void>;
  markProcessed(id: string, processedAt: string): Promise<void>;
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
}

/** Container of every repository, wired by the factory. */
export interface Repositories {
  users: UserRepository;
  invites: InviteRepository;
  twoFactor: TwoFactorRepository;
  events: EventRepository;
  failures: FailureRepository;
  webhookDedup: WebhookDedupRepository;
  reconciliation: ReconciliationRepository;
  connectorStates: ConnectorStateRepository;
  payments: PaymentRepository;
}
