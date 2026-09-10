import { randomUUID } from 'node:crypto';
import { ConflictError } from '../lib/errors.js';
import type {
  ConnectorState,
  Failure,
  LifecycleEvent,
  Payment,
  ReconciliationJob,
} from '../domain/types.js';
import type { AuthUser, Invite, PolicyAttribute, TwoFactorChallenge } from '../auth/types.js';
import type {
  ConnectorStateRepository,
  EventRepository,
  FailureRepository,
  InviteRepository,
  PaymentRepository,
  ReconciliationRepository,
  Repositories,
  TwoFactorRepository,
  UserRepository,
  WebhookDedupRepository,
} from './types.js';

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

  async incrementAttempts(id: string): Promise<number> {
    const challenge = this.byId.get(id);
    if (!challenge) {
      return 0;
    }
    challenge.attempts += 1;
    return challenge.attempts;
  }

  async consume(id: string): Promise<void> {
    this.byId.delete(id);
  }
}

export class InMemoryEventRepository implements EventRepository {
  private readonly events: LifecycleEvent[] = [];

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    this.events.push(event);
    return event;
  }

  async list(organizationIds: string[]): Promise<LifecycleEvent[]> {
    const allowed = new Set(organizationIds);
    return this.events
      .filter((event) => allowed.has(event.organizationId))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 500);
  }
}

export class InMemoryFailureRepository implements FailureRepository {
  private readonly failures: Failure[] = [];

  async append(failure: Failure): Promise<Failure> {
    this.failures.push(failure);
    return failure;
  }

  async list(organizationIds: string[]): Promise<Failure[]> {
    const allowed = new Set(organizationIds);
    return this.failures
      .filter((failure) => allowed.has(failure.organizationId))
      .sort((a, b) => b.since.localeCompare(a.since))
      .slice(0, 500);
  }

  async acknowledge(
    id: string,
    acknowledgedAt: string,
    organizationIds: string[],
  ): Promise<Failure | undefined> {
    const allowed = new Set(organizationIds);
    const failure = this.failures.find(
      (candidate) => candidate.id === id && allowed.has(candidate.organizationId),
    );
    if (!failure) {
      return undefined;
    }
    failure.acknowledgedAt = acknowledgedAt;
    return failure;
  }
}

export class InMemoryWebhookDedupRepository implements WebhookDedupRepository {
  private readonly processing = new Set<string>();
  private readonly processed = new Set<string>();

  async hasProcessed(id: string): Promise<boolean> {
    return this.processed.has(id);
  }

  async markProcessing(id: string, _processedAt: string): Promise<void> {
    this.processing.add(id);
  }

  async markProcessed(id: string, _processedAt: string): Promise<void> {
    this.processing.delete(id);
    this.processed.add(id);
  }
}

export class InMemoryReconciliationRepository implements ReconciliationRepository {
  private readonly jobs: ReconciliationJob[] = [];

  async create(job: ReconciliationJob): Promise<ReconciliationJob> {
    this.jobs.push(job);
    return job;
  }

  async list(organizationIds: string[]): Promise<ReconciliationJob[]> {
    const allowed = new Set(organizationIds);
    return this.jobs
      .filter((job) => allowed.has(job.organizationId))
      .sort((a, b) => b.runAt.localeCompare(a.runAt))
      .slice(0, 100);
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
    note: 'Adaptor connected (stub)',
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

  async list(organizationIds: string[]): Promise<ConnectorState[]> {
    const allowed = new Set(organizationIds);
    return [...this.states.values()]
      .filter((state) => allowed.has(state.organizationId))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly byId = new Map<string, Payment>();

  async create(payment: Payment): Promise<Payment> {
    this.byId.set(payment.id, payment);
    return payment;
  }

  async findById(id: string, organizationIds: string[]): Promise<Payment | undefined> {
    const payment = this.byId.get(id);
    if (!payment) {
      return undefined;
    }
    return organizationIds.includes(payment.organizationId) ? payment : undefined;
  }
}

/** Build a fresh set of in-memory repositories. */
export function createInMemoryRepositories(): Repositories {
  return {
    users: new InMemoryUserRepository(),
    invites: new InMemoryInviteRepository(),
    twoFactor: new InMemoryTwoFactorRepository(),
    events: new InMemoryEventRepository(),
    failures: new InMemoryFailureRepository(),
    webhookDedup: new InMemoryWebhookDedupRepository(),
    reconciliation: new InMemoryReconciliationRepository(),
    connectorStates: new InMemoryConnectorStateRepository(),
    payments: new InMemoryPaymentRepository(),
  };
}
