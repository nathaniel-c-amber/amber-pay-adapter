import { randomUUID } from 'node:crypto';
import { ConflictError } from '../utils/errors.js';
import type {
  ConnectorState,
  Failure,
  LifecycleEvent,
  Payment,
  ReconciliationJob,
} from '../models/domain.js';
import type { AuthUser, Invite, PasswordReset, PolicyAttribute, TwoFactorChallenge } from '../types/auth.js';
import type {
  ConnectorStateRepository,
  EventRepository,
  FailureRepository,
  InviteRepository,
  PasswordResetRepository,
  PaymentRepository,
  ReconciliationRepository,
  Repositories,
  TwoFactorRepository,
  UserRepository,
  WebhookDedupRepository,
} from '../types/repository.js';
import { WEBHOOK_CLAIM_LEASE_MS } from '../types/repository.js';

/**
 * In-memory repository implementations. Used in tests (which MUST run without
 * a live DB) and as a fallback when no database is configured. Data is lost on
 * restart.
 */

export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, AuthUser>();
  private readonly byEmail = new Map<string, AuthUser>();

  async create(
    email: string,
    hashedPassword: string,
    policyAttributes: PolicyAttribute[],
  ): Promise<AuthUser> {
    const normalizedEmail = email.trim().toLowerCase();
    if (this.byEmail.has(normalizedEmail)) {
      throw new ConflictError('A user with this email already exists');
    }
    const now = new Date().toISOString();
    const user: AuthUser = {
      id: randomUUID(),
      email: normalizedEmail,
      hashedPassword,
      tourCompletedAt: null,
      createdAt: now,
      updatedAt: now,
      policyAttributes,
    };
    this.byId.set(user.id, user);
    this.byEmail.set(normalizedEmail, user);
    return user;
  }

  async findByEmail(email: string): Promise<AuthUser | undefined> {
    return this.byEmail.get(email.trim().toLowerCase());
  }

  async findById(id: string): Promise<AuthUser | undefined> {
    return this.byId.get(id);
  }

  async list(): Promise<AuthUser[]> {
    return [...this.byId.values()].sort((a, b) => a.email.localeCompare(b.email));
  }

  async updatePolicyAttributes(
    id: string,
    policyAttributes: PolicyAttribute[],
  ): Promise<AuthUser | undefined> {
    const user = this.byId.get(id);
    if (!user) {
      return undefined;
    }
    // Replace the array rather than mutating in place: the stored object is
    // handed out by reference, so an in-place push would retroactively change
    // a caller's copy of the previous attributes.
    const updated: AuthUser = {
      ...user,
      policyAttributes,
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    this.byEmail.set(updated.email, updated);
    return updated;
  }

  async updatePassword(id: string, hashedPassword: string): Promise<boolean> {
    const user = this.byId.get(id);
    if (!user) {
      return false;
    }
    const updated: AuthUser = {
      ...user,
      hashedPassword,
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    this.byEmail.set(updated.email, updated);
    return true;
  }

  async markTourCompleted(id: string, at: string): Promise<boolean> {
    const user = this.byId.get(id);
    // Already stamped, or no such account: nothing to write. An existing stamp
    // is never overwritten, so a replay cannot rewrite when the user was first
    // toured.
    if (!user || user.tourCompletedAt !== null) {
      return false;
    }
    const updated: AuthUser = {
      ...user,
      tourCompletedAt: at,
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    this.byEmail.set(updated.email, updated);
    return true;
  }
}

export class InMemoryInviteRepository implements InviteRepository {
  private readonly byTokenHash = new Map<string, Invite>();

  async create(invite: Invite): Promise<Invite> {
    this.byTokenHash.set(invite.tokenHash, invite);
    return invite;
  }

  async findByTokenHash(tokenHash: string): Promise<Invite | undefined> {
    return this.byTokenHash.get(tokenHash);
  }

  async markAccepted(id: string, acceptedAt: string): Promise<void> {
    for (const invite of this.byTokenHash.values()) {
      if (invite.id === id) {
        invite.acceptedAt = acceptedAt;
        return;
      }
    }
  }

  async list(): Promise<Invite[]> {
    return [...this.byTokenHash.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
}

export class InMemoryPasswordResetRepository implements PasswordResetRepository {
  private readonly byTokenHash = new Map<string, PasswordReset>();

  async create(reset: PasswordReset): Promise<PasswordReset> {
    this.byTokenHash.set(reset.tokenHash, reset);
    return reset;
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordReset | undefined> {
    return this.byTokenHash.get(tokenHash);
  }

  async consume(tokenHash: string, usedAt: string): Promise<string | undefined> {
    const reset = this.byTokenHash.get(tokenHash);
    if (!reset || reset.usedAt) {
      return undefined;
    }
    if (new Date(reset.expiresAt).getTime() <= new Date(usedAt).getTime()) {
      return undefined;
    }
    reset.usedAt = usedAt;
    return reset.userId;
  }

  async invalidateForUser(userId: string, usedAt: string): Promise<void> {
    for (const reset of this.byTokenHash.values()) {
      if (reset.userId === userId && !reset.usedAt) {
        reset.usedAt = usedAt;
      }
    }
  }
}

export class InMemoryTwoFactorRepository implements TwoFactorRepository {
  private readonly byId = new Map<string, TwoFactorChallenge>();

  async create(challenge: TwoFactorChallenge): Promise<TwoFactorChallenge> {
    this.byId.set(challenge.id, challenge);
    return challenge;
  }

  async findById(id: string): Promise<TwoFactorChallenge | undefined> {
    return this.byId.get(id);
  }

  async spendAttempt(id: string, maxAttempts: number): Promise<number | undefined> {
    const challenge = this.byId.get(id);
    if (!challenge || challenge.attempts >= maxAttempts) {
      return undefined;
    }
    challenge.attempts += 1;
    return challenge.attempts;
  }

  async consume(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }
}

export class InMemoryEventRepository implements EventRepository {
  private readonly events: LifecycleEvent[] = [];

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    this.events.push(event);
    return event;
  }

  async list(organizationIds: string[] | null): Promise<LifecycleEvent[]> {
    const events =
      organizationIds === null
        ? [...this.events]
        : this.events.filter((event) => organizationIds.includes(event.organizationId));
    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500);
  }
}

export class InMemoryFailureRepository implements FailureRepository {
  private readonly failures: Failure[] = [];

  async append(failure: Failure): Promise<Failure> {
    this.failures.push(failure);
    return failure;
  }

  async list(organizationIds: string[] | null): Promise<Failure[]> {
    const failures =
      organizationIds === null
        ? [...this.failures]
        : this.failures.filter((failure) => organizationIds.includes(failure.organizationId));
    return failures.sort((a, b) => b.since.localeCompare(a.since)).slice(0, 500);
  }

  async acknowledge(
    id: string,
    acknowledgedAt: string,
    organizationIds: string[] | null,
  ): Promise<Failure | undefined> {
    const failure = this.failures.find(
      (candidate) =>
        candidate.id === id &&
        (organizationIds === null || organizationIds.includes(candidate.organizationId)),
    );
    if (!failure) {
      return undefined;
    }
    failure.acknowledgedAt = acknowledgedAt;
    return failure;
  }
}

export class InMemoryWebhookDedupRepository implements WebhookDedupRepository {
  /** id -> claim timestamp in ms, or null once processed. */
  private readonly claims = new Map<string, number | null>();

  async claim(id: string, _processedAt: string): Promise<boolean> {
    const existing = this.claims.get(id);
    if (existing === undefined) {
      this.claims.set(id, Date.now());
      return true;
    }
    if (existing === null) {
      // Already processed — permanently deduplicated.
      return false;
    }
    // Reclaim only a claim whose holder is presumed dead, mirroring the
    // Postgres lease so both implementations agree on the contract.
    if (Date.now() - existing > WEBHOOK_CLAIM_LEASE_MS) {
      this.claims.set(id, Date.now());
      return true;
    }
    return false;
  }

  async markProcessed(id: string, _processedAt: string): Promise<void> {
    this.claims.set(id, null);
  }

  async release(id: string): Promise<void> {
    this.claims.delete(id);
  }
}

export class InMemoryReconciliationRepository implements ReconciliationRepository {
  private readonly jobs: ReconciliationJob[] = [];

  async create(job: ReconciliationJob): Promise<ReconciliationJob> {
    this.jobs.push(job);
    return job;
  }

  async list(organizationIds: string[] | null): Promise<ReconciliationJob[]> {
    const jobs =
      organizationIds === null
        ? [...this.jobs]
        : this.jobs.filter((job) => organizationIds.includes(job.organizationId));
    return jobs.sort((a, b) => b.runAt.localeCompare(a.runAt)).slice(0, 100);
  }
}

/** Default connectors surfaced on the dashboard until live state is wired. */
export const DEFAULT_CONNECTOR_STATES: ConnectorState[] = [
  {
    id: 'quickbooks',
    organizationId: 'org-1',
    label: 'QuickBooks Online',
    terminus: 'quickbooks',
    status: 'open',
    reading: 'Operational',
    // NOT "adaptor connected": the adaptor's connection is live state and is
    // overlaid on this row by `applyAdaptorState` — a seeded claim about it was
    // wrong the moment the credentials changed.
    note: 'Awaiting adaptor state',
  },
  {
    id: 'sage',
    organizationId: 'org-1',
    label: 'Sage',
    terminus: 'sage',
    status: 'arriving',
    reading: 'Pending',
    note: 'Adaptor not configured',
  },
  {
    id: 'amber-pay',
    organizationId: 'org-1',
    label: 'Amber Pay Gateway',
    terminus: 'amber-pay',
    status: 'open',
    reading: 'Operational',
    note: 'Webhook ingestion active',
  },
];

export class InMemoryConnectorStateRepository implements ConnectorStateRepository {
  private readonly states = new Map<string, ConnectorState>();

  constructor(seed: ConnectorState[] = DEFAULT_CONNECTOR_STATES) {
    for (const state of seed) {
      this.states.set(state.id, state);
    }
  }

  async upsert(state: ConnectorState): Promise<ConnectorState> {
    this.states.set(state.id, state);
    return state;
  }

  async list(organizationIds: string[] | null): Promise<ConnectorState[]> {
    const states =
      organizationIds === null
        ? [...this.states.values()]
        : [...this.states.values()].filter((state) =>
            organizationIds.includes(state.organizationId),
          );
    return states.sort((a, b) => a.id.localeCompare(b.id));
  }
}

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly byId = new Map<string, Payment>();

  async create(payment: Payment): Promise<Payment> {
    this.byId.set(payment.id, payment);
    return payment;
  }

  async findById(id: string, organizationIds: string[] | null): Promise<Payment | undefined> {
    const payment = this.byId.get(id);
    if (!payment) {
      return undefined;
    }
    return organizationIds === null || organizationIds.includes(payment.organizationId)
      ? payment
      : undefined;
  }
}

/** Build a fresh set of in-memory repositories. */
export function createInMemoryRepositories(): Repositories {
  return {
    users: new InMemoryUserRepository(),
    invites: new InMemoryInviteRepository(),
    twoFactor: new InMemoryTwoFactorRepository(),
    passwordResets: new InMemoryPasswordResetRepository(),
    events: new InMemoryEventRepository(),
    failures: new InMemoryFailureRepository(),
    webhookDedup: new InMemoryWebhookDedupRepository(),
    reconciliation: new InMemoryReconciliationRepository(),
    connectorStates: new InMemoryConnectorStateRepository(),
    payments: new InMemoryPaymentRepository(),
  };
}
