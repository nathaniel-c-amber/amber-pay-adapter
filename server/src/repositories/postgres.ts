import type { Pool } from 'pg';
import { ConflictError, InternalError } from '../lib/errors.js';
import type {
  ConnectorState,
  Failure,
  LifecycleEvent,
  Payment,
  ReconciliationJob,
  Severity,
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
 * Postgres-backed repository implementations. Exercised at runtime when a
 * database is configured. All queries are parameterized.
 */

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// --- users -----------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  hashed_password: string;
  policy_attributes: PolicyAttribute[];
  created_at: Date;
  updated_at: Date;
}

const USER_COLUMNS = 'id, email, hashed_password, policy_attributes, created_at, updated_at';

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    hashedPassword: row.hashed_password,
    policyAttributes: row.policy_attributes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    email: string,
    hashedPassword: string,
    policyAttributes: PolicyAttribute[],
  ): Promise<AuthUser> {
    try {
      const result = await this.pool.query<UserRow>(
        `INSERT INTO users (email, hashed_password, policy_attributes)
         VALUES ($1, $2, $3::jsonb)
         RETURNING ${USER_COLUMNS}`,
        [email.trim().toLowerCase(), hashedPassword, JSON.stringify(policyAttributes)],
      );
      const row = result.rows[0];
      if (!row) {
        throw new InternalError('Failed to create user');
      }
      return toAuthUser(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('A user with this email already exists');
      }
      throw err;
    }
  }

  async findByEmail(email: string): Promise<AuthUser | undefined> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
      [email.trim().toLowerCase()],
    );
    const row = result.rows[0];
    return row ? toAuthUser(row) : undefined;
  }

  async findById(id: string): Promise<AuthUser | undefined> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toAuthUser(row) : undefined;
  }
}

// --- invites ---------------------------------------------------------------

interface InviteRow {
  id: string;
  email: string;
  policy_attributes: PolicyAttribute[];
  token_hash: string;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}

const INVITE_COLUMNS =
  'id, email, policy_attributes, token_hash, expires_at, accepted_at, created_at';

function toInvite(row: InviteRow): Invite {
  const invite: Invite = {
    id: row.id,
    email: row.email,
    policyAttributes: row.policy_attributes,
    tokenHash: row.token_hash,
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
  };
  if (row.accepted_at) {
    invite.acceptedAt = toIso(row.accepted_at);
  }
  return invite;
}

export class PostgresInviteRepository implements InviteRepository {
  constructor(private readonly pool: Pool) {}

  async create(invite: Invite): Promise<Invite> {
    await this.pool.query(
      `INSERT INTO invites (id, email, policy_attributes, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [
        invite.id,
        invite.email,
        JSON.stringify(invite.policyAttributes),
        invite.tokenHash,
        invite.expiresAt,
        invite.createdAt,
      ],
    );
    return invite;
  }

  async findByTokenHash(tokenHash: string): Promise<Invite | undefined> {
    const result = await this.pool.query<InviteRow>(
      `SELECT ${INVITE_COLUMNS} FROM invites WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? toInvite(row) : undefined;
  }

  async markAccepted(id: string, acceptedAt: string): Promise<void> {
    await this.pool.query('UPDATE invites SET accepted_at = $2 WHERE id = $1', [id, acceptedAt]);
  }
}

// --- two-factor challenges -------------------------------------------------

interface TwoFactorRow {
  id: string;
  user_id: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
}

const TWO_FACTOR_COLUMNS = 'id, user_id, code_hash, expires_at, attempts';

function toTwoFactorChallenge(row: TwoFactorRow): TwoFactorChallenge {
  return {
    id: row.id,
    userId: row.user_id,
    codeHash: row.code_hash,
    expiresAt: toIso(row.expires_at),
    attempts: row.attempts,
  };
}

export class PostgresTwoFactorRepository implements TwoFactorRepository {
  constructor(private readonly pool: Pool) {}

  async create(challenge: TwoFactorChallenge): Promise<TwoFactorChallenge> {
    await this.pool.query(
      `INSERT INTO two_factor_challenges (id, user_id, code_hash, expires_at, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [challenge.id, challenge.userId, challenge.codeHash, challenge.expiresAt, challenge.attempts],
    );
    return challenge;
  }

  async findById(id: string): Promise<TwoFactorChallenge | undefined> {
    const result = await this.pool.query<TwoFactorRow>(
      `SELECT ${TWO_FACTOR_COLUMNS} FROM two_factor_challenges
       WHERE id = $1 AND consumed_at IS NULL`,
      [id],
    );
    const row = result.rows[0];
    return row ? toTwoFactorChallenge(row) : undefined;
  }

  async incrementAttempts(id: string): Promise<number> {
    const result = await this.pool.query<{ attempts: number }>(
      `UPDATE two_factor_challenges SET attempts = attempts + 1
       WHERE id = $1
       RETURNING attempts`,
      [id],
    );
    return result.rows[0]?.attempts ?? 0;
  }

  async consume(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE two_factor_challenges SET consumed_at = now() WHERE id = $1',
      [id],
    );
  }
}

// --- lifecycle events ------------------------------------------------------

interface EventRow {
  id: string;
  organization_id: string;
  at: Date;
  type: string;
  channel: string;
  ref: string;
  detail: string;
}

const EVENT_COLUMNS = 'id, organization_id, at, type, channel, ref, detail';

function toLifecycleEvent(row: EventRow): LifecycleEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    at: toIso(row.at),
    type: row.type as LifecycleEvent['type'],
    channel: row.channel as LifecycleEvent['channel'],
    ref: row.ref,
    detail: row.detail,
  };
}

export class PostgresEventRepository implements EventRepository {
  constructor(private readonly pool: Pool) {}

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    await this.pool.query(
      `INSERT INTO lifecycle_events (id, organization_id, at, type, channel, ref, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event.id, event.organizationId, event.at, event.type, event.channel, event.ref, event.detail],
    );
    return event;
  }

  async list(organizationIds: string[] | null): Promise<LifecycleEvent[]> {
    const where = organizationIds === null ? '' : 'WHERE organization_id = ANY($1)';
    const params = organizationIds === null ? [] : [organizationIds];
    const result = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM lifecycle_events ${where}
       ORDER BY at DESC LIMIT 500`,
      params,
    );
    return result.rows.map(toLifecycleEvent);
  }
}

// --- failures --------------------------------------------------------------

interface FailureRow {
  id: string;
  organization_id: string;
  severity: string;
  channel: string;
  title: string;
  detail: string;
  since: Date;
  acknowledged_at: Date | null;
}

const FAILURE_COLUMNS =
  'id, organization_id, severity, channel, title, detail, since, acknowledged_at';

function toFailure(row: FailureRow): Failure {
  const failure: Failure = {
    id: row.id,
    organizationId: row.organization_id,
    severity: row.severity as Severity,
    channel: row.channel as Failure['channel'],
    title: row.title,
    detail: row.detail,
    since: toIso(row.since),
  };
  if (row.acknowledged_at) {
    failure.acknowledgedAt = toIso(row.acknowledged_at);
  }
  return failure;
}

export class PostgresFailureRepository implements FailureRepository {
  constructor(private readonly pool: Pool) {}

  async append(failure: Failure): Promise<Failure> {
    await this.pool.query(
      `INSERT INTO failures (id, organization_id, severity, channel, title, detail, since)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        failure.id,
        failure.organizationId,
        failure.severity,
        failure.channel,
        failure.title,
        failure.detail,
        failure.since,
      ],
    );
    return failure;
  }

  async list(organizationIds: string[] | null): Promise<Failure[]> {
    const where = organizationIds === null ? '' : 'WHERE organization_id = ANY($1)';
    const params = organizationIds === null ? [] : [organizationIds];
    const result = await this.pool.query<FailureRow>(
      `SELECT ${FAILURE_COLUMNS} FROM failures ${where}
       ORDER BY since DESC LIMIT 500`,
      params,
    );
    return result.rows.map(toFailure);
  }

  async acknowledge(
    id: string,
    acknowledgedAt: string,
    organizationIds: string[] | null,
  ): Promise<Failure | undefined> {
    const result =
      organizationIds === null
        ? await this.pool.query<FailureRow>(
            `UPDATE failures SET acknowledged_at = $2 WHERE id = $1
             RETURNING ${FAILURE_COLUMNS}`,
            [id, acknowledgedAt],
          )
        : await this.pool.query<FailureRow>(
            `UPDATE failures SET acknowledged_at = $2
             WHERE id = $1 AND organization_id = ANY($3)
             RETURNING ${FAILURE_COLUMNS}`,
            [id, acknowledgedAt, organizationIds],
          );
    const row = result.rows[0];
    return row ? toFailure(row) : undefined;
  }
}

// --- webhook dedup ---------------------------------------------------------

export class PostgresWebhookDedupRepository implements WebhookDedupRepository {
  constructor(private readonly pool: Pool) {}

  async hasProcessed(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM processed_webhooks WHERE id = $1 AND state = $2',
      [id, 'processed'],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async markProcessing(id: string, processedAt: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO processed_webhooks (id, state, processed_at) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, 'processing', processedAt],
    );
  }

  async markProcessed(id: string, processedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE processed_webhooks SET state = $2, processed_at = $3 WHERE id = $1`,
      [id, 'processed', processedAt],
    );
  }
}

// --- reconciliation --------------------------------------------------------

interface ReconciliationRow {
  id: string;
  organization_id: string;
  run_at: Date;
  status: string;
  matched: number;
  unmatched: number;
  anomalies: number;
}

function toReconciliationJob(row: ReconciliationRow): ReconciliationJob {
  return {
    id: row.id,
    organizationId: row.organization_id,
    runAt: toIso(row.run_at),
    status: row.status as ReconciliationJob['status'],
    summary: {
      status: row.status,
      matched: row.matched,
      unmatched: row.unmatched,
      anomalies: row.anomalies,
      ranAt: toIso(row.run_at),
    },
  };
}

export class PostgresReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly pool: Pool) {}

  async create(job: ReconciliationJob): Promise<ReconciliationJob> {
    await this.pool.query(
      `INSERT INTO reconciliation_jobs (id, organization_id, run_at, status, matched, unmatched, anomalies)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        job.id,
        job.organizationId,
        job.runAt,
        job.status,
        job.summary.matched,
        job.summary.unmatched,
        job.summary.anomalies,
      ],
    );
    return job;
  }

  async list(organizationIds: string[] | null): Promise<ReconciliationJob[]> {
    const where = organizationIds === null ? '' : 'WHERE organization_id = ANY($1)';
    const params = organizationIds === null ? [] : [organizationIds];
    const result = await this.pool.query<ReconciliationRow>(
      `SELECT id, organization_id, run_at, status, matched, unmatched, anomalies
       FROM reconciliation_jobs ${where}
       ORDER BY run_at DESC LIMIT 100`,
      params,
    );
    return result.rows.map(toReconciliationJob);
  }
}

// --- connector states ------------------------------------------------------

interface ConnectorRow {
  id: string;
  organization_id: string;
  label: string;
  terminus: string;
  status: string;
  reading: string;
  note: string;
}

function toConnectorState(row: ConnectorRow): ConnectorState {
  return {
    id: row.id,
    organizationId: row.organization_id,
    label: row.label,
    terminus: row.terminus as ConnectorState['terminus'],
    status: row.status as ConnectorState['status'],
    reading: row.reading,
    note: row.note,
  };
}

export class PostgresConnectorStateRepository implements ConnectorStateRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(state: ConnectorState): Promise<ConnectorState> {
    await this.pool.query(
      `INSERT INTO connector_states (id, organization_id, label, terminus, status, reading, note, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (id) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         label = EXCLUDED.label,
         terminus = EXCLUDED.terminus,
         status = EXCLUDED.status,
         reading = EXCLUDED.reading,
         note = EXCLUDED.note,
         updated_at = now()`,
      [
        state.id,
        state.organizationId,
        state.label,
        state.terminus,
        state.status,
        state.reading,
        state.note,
      ],
    );
    return state;
  }

  async list(organizationIds: string[] | null): Promise<ConnectorState[]> {
    const where = organizationIds === null ? '' : 'WHERE organization_id = ANY($1)';
    const params = organizationIds === null ? [] : [organizationIds];
    const result = await this.pool.query<ConnectorRow>(
      `SELECT id, organization_id, label, terminus, status, reading, note
       FROM connector_states ${where}
       ORDER BY id`,
      params,
    );
    return result.rows.map(toConnectorState);
  }
}

// --- payments --------------------------------------------------------------

interface PaymentRow {
  id: string;
  invoice_id: string | null;
  organization_id: string;
  transaction_id: string;
  status: string;
  processed_at: Date;
}

const PAYMENT_COLUMNS = 'id, invoice_id, organization_id, transaction_id, status, processed_at';

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    invoiceId: row.invoice_id ?? '',
    organizationId: row.organization_id,
    transactionId: row.transaction_id,
    status: row.status as Payment['status'],
    processedAt: toIso(row.processed_at),
  };
}

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(private readonly pool: Pool) {}

  async create(payment: Payment): Promise<Payment> {
    await this.pool.query(
      `INSERT INTO payments (id, invoice_id, organization_id, transaction_id, status, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        payment.id,
        payment.invoiceId,
        payment.organizationId,
        payment.transactionId,
        payment.status,
        payment.processedAt,
      ],
    );
    return payment;
  }

  async findById(id: string, organizationIds: string[] | null): Promise<Payment | undefined> {
    const result =
      organizationIds === null
        ? await this.pool.query<PaymentRow>(
            `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`,
            [id],
          )
        : await this.pool.query<PaymentRow>(
            `SELECT ${PAYMENT_COLUMNS} FROM payments
             WHERE id = $1 AND organization_id = ANY($2)`,
            [id, organizationIds],
          );
    const row = result.rows[0];
    return row ? toPayment(row) : undefined;
  }
}

/** Build a full set of Postgres repositories over the given pool. */
export function createPostgresRepositories(pool: Pool): Repositories {
  return {
    users: new PostgresUserRepository(pool),
    invites: new PostgresInviteRepository(pool),
    twoFactor: new PostgresTwoFactorRepository(pool),
    events: new PostgresEventRepository(pool),
    failures: new PostgresFailureRepository(pool),
    webhookDedup: new PostgresWebhookDedupRepository(pool),
    reconciliation: new PostgresReconciliationRepository(pool),
    connectorStates: new PostgresConnectorStateRepository(pool),
    payments: new PostgresPaymentRepository(pool),
  };
}
