import type { Pool } from 'pg';
import { ConflictError, InternalError } from '../utils/errors.js';
import type {
  ConnectorState,
  Failure,
  LifecycleEvent,
  Payment,
  ReconciliationJob,
  Severity,
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
  SettingsRepository,
  TwoFactorRepository,
  UserRepository,
  WebhookDedupRepository,
} from '../types/repository.js';
import { withoutUndefined } from '../models/deploymentSettings.js';
import type {
  DeploymentSettings,
  DeploymentSettingsPatch,
} from '../models/deploymentSettings.js';
import { WEBHOOK_CLAIM_LEASE_MS } from '../types/repository.js';
import { DuplicateTransactionIdError, DuplicateStatusTokenError } from '../services/gateway/checkout.service.js';
import type { CheckoutIntentStore } from '../services/gateway/checkout.service.js';
import type { GatewayStatusStore } from '../services/gateway/transactionStatus.service.js';
import type {
  CheckoutStatusRow,
  CustomerPaymentStatus,
  PaymentOutcomeStore,
  PaymentStatusStore,
} from '../services/payments/paymentStatus.service.js';

/**
 * Postgres-backed repository implementations. Exercised at runtime when a
 * database is configured. All queries are parameterized.
 */

/**
 * Is this a unique violation?
 *
 * `constraint` narrows it to ONE named index. That matters for the checkout
 * intent store: its retry can only tell "someone already has this id" from
 * every other fault by the constraint name, and matching on the SQLSTATE alone
 * would classify an unrelated collision as an id clash and send the caller round
 * the retry loop for nothing.
 */
function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code !== '23505') return false;
  return constraint === undefined || (err as { constraint?: unknown }).constraint === constraint;
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
  tour_completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const USER_COLUMNS =
  'id, email, hashed_password, policy_attributes, tour_completed_at, created_at, updated_at';

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    hashedPassword: row.hashed_password,
    policyAttributes: row.policy_attributes,
    // NULL means "never offered", which is the state every newly invited
    // account starts in.
    tourCompletedAt: row.tour_completed_at ? toIso(row.tour_completed_at) : null,
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

  async list(): Promise<AuthUser[]> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users ORDER BY email`,
    );
    return result.rows.map(toAuthUser);
  }

  async updatePolicyAttributes(
    id: string,
    policyAttributes: PolicyAttribute[],
  ): Promise<AuthUser | undefined> {
    const result = await this.pool.query<UserRow>(
      `UPDATE users
         SET policy_attributes = $2::jsonb, updated_at = now()
       WHERE id = $1
       RETURNING ${USER_COLUMNS}`,
      [id, JSON.stringify(policyAttributes)],
    );
    const row = result.rows[0];
    return row ? toAuthUser(row) : undefined;
  }

  async updatePassword(id: string, hashedPassword: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE users SET hashed_password = $2, updated_at = now() WHERE id = $1',
      [id, hashedPassword],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markTourCompleted(id: string, at: string): Promise<boolean> {
    // ONE conditional statement, never read-then-write: two concurrent calls
    // cannot both win, and the `IS NULL` guard means an existing stamp is never
    // rewritten by a replay. Same shape as the webhook claim and the reset-token
    // consume, for the same reason.
    const result = await this.pool.query(
      `UPDATE users
          SET tour_completed_at = $2, updated_at = now()
        WHERE id = $1 AND tour_completed_at IS NULL`,
      [id, at],
    );
    return (result.rowCount ?? 0) > 0;
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

  async list(): Promise<Invite[]> {
    const result = await this.pool.query<InviteRow>(
      `SELECT ${INVITE_COLUMNS} FROM invites ORDER BY created_at DESC`,
    );
    return result.rows.map(toInvite);
  }
}

// --- password resets -------------------------------------------------------

interface PasswordResetRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

const PASSWORD_RESET_COLUMNS =
  'id, user_id, token_hash, expires_at, used_at, created_at';

function toPasswordReset(row: PasswordResetRow): PasswordReset {
  const reset: PasswordReset = {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
  };
  if (row.used_at) {
    reset.usedAt = toIso(row.used_at);
  }
  return reset;
}

export class PostgresPasswordResetRepository implements PasswordResetRepository {
  constructor(private readonly pool: Pool) {}

  async create(reset: PasswordReset): Promise<PasswordReset> {
    await this.pool.query(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [reset.id, reset.userId, reset.tokenHash, reset.expiresAt, reset.createdAt],
    );
    return reset;
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordReset | undefined> {
    const result = await this.pool.query<PasswordResetRow>(
      `SELECT ${PASSWORD_RESET_COLUMNS} FROM password_resets WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? toPasswordReset(row) : undefined;
  }

  /**
   * Single-statement redemption. `used_at IS NULL AND expires_at > now()` in
   * the WHERE clause means the row is only updated by the first caller to get
   * there, and `RETURNING user_id` tells that caller it won.
   */
  async consume(tokenHash: string, usedAt: string): Promise<string | undefined> {
    const result = await this.pool.query<{ user_id: string }>(
      `UPDATE password_resets
          SET used_at = $2
        WHERE token_hash = $1
          AND used_at IS NULL
          AND expires_at > now()
        RETURNING user_id`,
      [tokenHash, usedAt],
    );
    return result.rows[0]?.user_id;
  }

  async invalidateForUser(userId: string, usedAt: string): Promise<void> {
    await this.pool.query(
      'UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL',
      [userId, usedAt],
    );
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

  /**
   * Enforce the attempt cap inside the update, so the limit is authoritative
   * rather than advisory. No row comes back once the cap is reached or the
   * challenge has been consumed, and `undefined` tells the caller not to verify.
   */
  async spendAttempt(id: string, maxAttempts: number): Promise<number | undefined> {
    const result = await this.pool.query<{ attempts: number }>(
      `UPDATE two_factor_challenges
          SET attempts = attempts + 1
        WHERE id = $1
          AND consumed_at IS NULL
          AND attempts < $2
        RETURNING attempts`,
      [id, maxAttempts],
    );
    return result.rows[0]?.attempts;
  }

  /** True only for the caller that transitioned the challenge to consumed. */
  async consume(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE two_factor_challenges
          SET consumed_at = now()
        WHERE id = $1 AND consumed_at IS NULL
        RETURNING id`,
      [id],
    );
    return result.rowCount !== null && result.rowCount > 0;
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
  acknowledged_by: string | null;
}

const FAILURE_COLUMNS =
  'id, organization_id, severity, channel, title, detail, since, acknowledged_at, acknowledged_by';

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
  if (row.acknowledged_by) {
    failure.acknowledgedBy = row.acknowledged_by;
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
    acknowledgedBy?: string,
  ): Promise<Failure | undefined> {
    const actor = acknowledgedBy ?? null;
    const result =
      organizationIds === null
        ? await this.pool.query<FailureRow>(
            `UPDATE failures SET acknowledged_at = $2, acknowledged_by = $3 WHERE id = $1
             RETURNING ${FAILURE_COLUMNS}`,
            [id, acknowledgedAt, actor],
          )
        : await this.pool.query<FailureRow>(
            `UPDATE failures SET acknowledged_at = $2, acknowledged_by = $3
             WHERE id = $1 AND organization_id = ANY($4)
             RETURNING ${FAILURE_COLUMNS}`,
            [id, acknowledgedAt, actor, organizationIds],
          );
    const row = result.rows[0];
    return row ? toFailure(row) : undefined;
  }

  /**
   * One statement for the whole batch: `WHERE id = ANY($1)` matches the set in
   * the index, and `RETURNING` gives back exactly the rows that changed. The
   * organization predicate is applied in the SAME statement rather than being
   * fetched first and filtered in application code, so a row the caller may not
   * see is never read, let alone acknowledged.
   */
  async acknowledgeMany(
    ids: string[],
    acknowledgedAt: string,
    organizationIds: string[] | null,
    acknowledgedBy?: string,
  ): Promise<Failure[]> {
    const actor = acknowledgedBy ?? null;
    const result =
      organizationIds === null
        ? await this.pool.query<FailureRow>(
            `UPDATE failures SET acknowledged_at = $2, acknowledged_by = $3
             WHERE id = ANY($1)
             RETURNING ${FAILURE_COLUMNS}`,
            [ids, acknowledgedAt, actor],
          )
        : await this.pool.query<FailureRow>(
            `UPDATE failures SET acknowledged_at = $2, acknowledged_by = $3
             WHERE id = ANY($1) AND organization_id = ANY($4)
             RETURNING ${FAILURE_COLUMNS}`,
            [ids, acknowledgedAt, actor, organizationIds],
          );
    return result.rows.map(toFailure);
  }
}

// --- webhook dedup ---------------------------------------------------------

export class PostgresWebhookDedupRepository implements WebhookDedupRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Atomically claim a webhook id in ONE statement.
   *
   * A read-then-write pair cannot express this: two concurrent deliveries would
   * both read "not processed". Here the insert either creates the row, or the
   * `ON CONFLICT ... WHERE` clause updates it only when the previous claim has
   * expired — so a processed id and a fresh in-flight id both yield no row, and
   * therefore no ownership.
   */
  async claim(id: string, processedAt: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO processed_webhooks (id, state, processed_at) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET state = EXCLUDED.state, processed_at = EXCLUDED.processed_at
         WHERE processed_webhooks.state = 'processing'
           AND processed_webhooks.processed_at
               < now() - ($4::bigint * interval '1 millisecond')
       RETURNING id`,
      [id, 'processing', processedAt, WEBHOOK_CLAIM_LEASE_MS],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async markProcessed(id: string, processedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE processed_webhooks SET state = $2, processed_at = $3 WHERE id = $1`,
      [id, 'processed', processedAt],
    );
  }

  async release(id: string): Promise<void> {
    await this.pool.query('DELETE FROM processed_webhooks WHERE id = $1', [id]);
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

/**
 * Persistence for a checkout intent — the record written BEFORE the gateway is
 * asked for anything.
 *
 * The unique-violation translation is the whole reason this is a class rather
 * than an inline query: the retry that guarantees a fresh transaction id can
 * only distinguish "someone already has this id" from every other fault if the
 * driver error is classified here, at the only place that knows what the
 * constraint is called. Matching on the constraint NAME rather than the SQLSTATE
 * alone means an unrelated unique violation is not silently reported as a
 * collision, which would send the caller round the retry loop for nothing.
 *
 * It implements FOUR contracts, because they are four questions about one row
 * and they must not be able to disagree: the write (what a checkout needs), the
 * status read (what a customer needs), the outcome write (what the webhook
 * processor needs), and the sealed-figure read (what the gateway's status API
 * needs). One class, one table, one place that knows its columns.
 */
export class PostgresCheckoutIntentStore
  implements CheckoutIntentStore, PaymentStatusStore, PaymentOutcomeStore, GatewayStatusStore
{
  constructor(private readonly pool: Pool) {}

  async create(input: {
    organizationId: string;
    transactionId: string;
    studentId: string;
    expectedSealed: Buffer;
    statusToken: string;
    statusTokenExpiresAt: Date;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO checkout_intents
           (organization_id, transaction_id, student_id, expected_sealed,
            status_token, status_token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.organizationId,
          input.transactionId,
          input.studentId,
          input.expectedSealed,
          input.statusToken,
          input.statusTokenExpiresAt,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err, 'checkout_intents_unique')) {
        throw new DuplicateTransactionIdError(input.transactionId);
      }
      // A token collision is reported as itself, not as an id collision. At 256
      // bits it is not a thing that happens; but if it ever did, retrying with a
      // fresh transaction id would be the wrong repair — the token is what two
      // checkouts would be sharing, and it has to be the token that is redrawn.
      if (isUniqueViolation(err, 'checkout_intents_status_token')) {
        throw new DuplicateStatusTokenError();
      }
      throw err;
    }
  }

  async findByTransactionId(
    organizationId: string,
    transactionId: string,
  ): Promise<{ studentId: string; statusToken: string | null } | undefined> {
    const result = await this.pool.query<{ student_id: string; status_token: string | null }>(
      `SELECT student_id, status_token FROM checkout_intents
        WHERE organization_id = $1 AND transaction_id = $2`,
      [organizationId, transactionId],
    );
    const row = result.rows[0];
    /*
      The EXPECTED CHARGE does not come back, and deliberately: attributing a
      callback needs to know WHO it was for, not what was expected. The figure
      lives inside the sealed column (see migration 007) and is read by a separate,
      explicit call when something actually needs it drawn — so a routine lookup
      never unseals a figure, and never has to invent a currency it did not read.

      `status_token` DOES come back, because the callback route is also the
      redirect route: the same delivery needs the customer to attribute the
      payment AND the handle to send their browser to, and reading them separately
      would be two chances for the row to be missing in between.
    */
    return row === undefined
      ? undefined
      : { studentId: row.student_id, statusToken: row.status_token };
  }

  /**
   * ★ THE SEALED FIGURE, FOR THE ONE CALL THAT GENUINELY NEEDS IT.
   *
   * A SEPARATE METHOD, not a field added to the read above, and the reason is
   * that the read above's comment is a promise: attributing a callback needs to
   * know WHO it was for, not what was expected, so a routine lookup never
   * unseals a figure. Widening it would quietly break that promise for every
   * caller at once. This one is single-purpose — `POST /gateway/v1/transactionstatus`
   * will not accept a request without a `Signature`, and the signature is
   * computed over `CurrencyCode` and `Amount`, which is the only reason anything
   * on this path may open the value at all.
   *
   * ORG-SCOPED on the same key as every other read of this table, so a lookup
   * cannot be pointed at another organization's payment by naming its id.
   *
   * Returned SEALED, and never opened here: the only opener is
   * `openExpectedCharge` in the service that needs the figure, which is what
   * keeps this method a read and not a second place money is understood.
   */
  async findExpectedChargeByTransactionId(
    organizationId: string,
    transactionId: string,
  ): Promise<{ expectedSealed: Buffer } | undefined> {
    const result = await this.pool.query<{ expected_sealed: Buffer }>(
      `SELECT expected_sealed FROM checkout_intents
        WHERE organization_id = $1 AND transaction_id = $2`,
      [organizationId, transactionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { expectedSealed: row.expected_sealed };
  }

  /**
   * The public status read. One equality probe on a unique index, and the expiry
   * is compared HERE rather than in application code so an expired token is
   * indistinguishable from one that never existed — which is the point, and is
   * why it is not a filter applied after the row is read.
   */
  async findByStatusToken(token: string): Promise<CheckoutStatusRow | undefined> {
    const result = await this.pool.query<{
      transaction_id: string;
      expected_sealed: Buffer;
      outcome: string | null;
      failure_reason: string | null;
    }>(
      `SELECT transaction_id, expected_sealed, outcome, failure_reason
         FROM checkout_intents
        WHERE status_token = $1 AND status_token_expires_at > now()`,
      [token],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      transactionId: row.transaction_id,
      expectedSealed: row.expected_sealed,
      // Narrowed against the persisted vocabulary rather than cast. The column
      // has a CHECK constraint, but a value this process does not recognise must
      // not be reported to a customer as a state it never described.
      outcome: isPersistedOutcome(row.outcome) ? row.outcome : null,
      failureReason: row.failure_reason,
    };
  }

  /**
   * Record what the gateway decided about a payment, so the customer's own page
   * can say so.
   *
   * Org-scoped on `(organization_id, transaction_id)` and NOT on the token: the
   * writer is the webhook processor, which knows the transaction id and the
   * deployment's organization, and matching the callback against the intent by
   * its own id is exactly the correlation the whole table exists for.
   *
   * `WHERE settled_at IS NULL` makes the write idempotent in the same direction
   * the rest of the flow is: a repeated callback cannot move a settled payment
   * backwards.
   *
   * ★ AND IT REPORTS WHETHER THE FACTS BELONG TO THIS DELIVERY, because that is
   * what lets a second delivery of one payment write them ONCE. The gateway's
   * callback url is also its redirect url, so one payment really does arrive
   * twice; the dedup repository releases the claim when the accounting push
   * fails, so the second delivery is deliberately allowed through. Without this
   * return value that delivery would re-write the `collected` lifecycle event,
   * and production showed exactly two of them five seconds apart.
   *
   * ★ THERE ARE THREE ANSWERS, NOT TWO, and conflating the third with "already
   * settled" would silently delete the system of record. `rowCount` alone cannot
   * tell "this payment was settled by an earlier delivery" from "there is no
   * intent row for this transaction at all" — both leave the UPDATE at zero — and
   * the second case is a real one: a payment made outside our checkout has no
   * row here, so every `collected` and `webhook-received` event for it would be
   * dropped, even though the money genuinely arrived. The events are the record
   * of what happened, so a payment we cannot correlate is exactly the one whose
   * events matter most.
   *
   * So the answer is `true` when the facts are THIS delivery's to write: it
   * transitioned the row, or there was no row to transition. It is `false` only
   * when a row exists that was already settled — the ordinary duplicate. Both
   * existence checks are index probes in the SAME statement, so the second
   * delivery still costs one round trip and cannot race a second query.
   */
  async recordOutcome(input: {
    organizationId: string;
    transactionId: string;
    outcome: Exclude<CustomerPaymentStatus, 'unknown'>;
    failureReason: string | null;
  }): Promise<boolean> {
    const result = await this.pool.query<{ transitioned: boolean; known: boolean }>(
      `WITH settled AS (
         UPDATE checkout_intents
            SET outcome = $3,
                failure_reason = $4,
                settled_at = now()
          WHERE organization_id = $1 AND transaction_id = $2 AND settled_at IS NULL
          RETURNING 1
       )
       SELECT
         EXISTS (SELECT 1 FROM settled) AS transitioned,
         EXISTS (
           SELECT 1 FROM checkout_intents
            WHERE organization_id = $1 AND transaction_id = $2
         ) AS known`,
      [input.organizationId, input.transactionId, input.outcome, input.failureReason],
    );
    const answer = result.rows[0];
    // No row at all from the CTE would mean the query itself did not run; treat
    // that as "not ours to write" so a broken query cannot multiply events.
    if (answer === undefined) return false;
    return answer.transitioned || !answer.known;
  }
}

/**
 * Is this a value the `outcome` column can legally hold?
 *
 * A runtime narrowing, not a cast: the CHECK constraint in migration 009 is the
 * database's promise, and this is the same promise made by the process that
 * reads it. An unrecognised value becomes "no verdict yet", which is a state a
 * customer page can render honestly — whereas passing it through would put a
 * string on the wire that the SPA has no branch for.
 */
function isPersistedOutcome(
  value: string | null,
): value is Exclude<CustomerPaymentStatus, 'unknown'> {
  return value === 'collected' || value === 'failed' || value === 'pending';
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
  async findByTransactionId(
    transactionId: string,
    organizationIds: string[] | null,
  ): Promise<Payment | undefined> {
    const result =
      organizationIds === null
        ? await this.pool.query<PaymentRow>(
            `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE transaction_id = $1 LIMIT 1`,
            [transactionId],
          )
        : await this.pool.query<PaymentRow>(
            `SELECT ${PAYMENT_COLUMNS} FROM payments
             WHERE transaction_id = $1 AND organization_id = ANY($2) LIMIT 1`,
            [transactionId, organizationIds],
          );
    const row = result.rows[0];
    return row === undefined ? undefined : toPayment(row);
  }

  async updateStatus(id: string, status: Payment['status']): Promise<Payment | undefined> {
    const result = await this.pool.query<PaymentRow>(
      `UPDATE payments SET status = $2 WHERE id = $1 RETURNING ${PAYMENT_COLUMNS}`,
      [id, status],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toPayment(row);
  }
}

// --- deployment settings ----------------------------------------------------

interface SettingsRow {
  organization_name: string | null;
  gateway_client_id: string | null;
  gateway_webhook_secret_sealed: Buffer | null;
  adaptor_id: string | null;
  adaptor_realm_id: string | null;
  adaptor_base_url: string | null;
  adaptor_credentials_sealed: Buffer | null;
  invoice_match_strategy: string | null;
  invoice_match_mode: string | null;
  invoice_match_field: string | null;
  payment_deposit_account_id: string | null;
  sync_interval: string | null;
  alert_target: string | null;
  verified_at: Date | null;
  configured_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SETTINGS_COLUMNS = `
  organization_name, gateway_client_id, gateway_webhook_secret_sealed,
  adaptor_id, adaptor_realm_id, adaptor_base_url, adaptor_credentials_sealed,
  invoice_match_strategy, invoice_match_mode, invoice_match_field,
  payment_deposit_account_id,
  sync_interval, alert_target, verified_at, configured_at, created_at, updated_at`;

function toSettings(row: SettingsRow): DeploymentSettings {
  return {
    organizationName: row.organization_name,
    gatewayClientId: row.gateway_client_id,
    gatewayWebhookSecret: row.gateway_webhook_secret_sealed,
    adaptorId: (row.adaptor_id as DeploymentSettings['adaptorId']) ?? null,
    adaptorRealmId: row.adaptor_realm_id,
    adaptorBaseUrl: row.adaptor_base_url,
    adaptorCredentials: row.adaptor_credentials_sealed,
    invoiceMatchStrategy:
      (row.invoice_match_strategy as DeploymentSettings['invoiceMatchStrategy']) ?? null,
    invoiceMatchMode: (row.invoice_match_mode as DeploymentSettings['invoiceMatchMode']) ?? null,
    invoiceMatchField: row.invoice_match_field,
    paymentDepositAccountId: row.payment_deposit_account_id,
    syncInterval: row.sync_interval,
    alertTarget: row.alert_target,
    verifiedAt: row.verified_at ? toIso(row.verified_at) : null,
    configuredAt: row.configured_at ? toIso(row.configured_at) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * The single settings row, from Postgres.
 *
 * `update` reads, merges and writes the whole row rather than assembling a
 * dynamic SET clause from the patch. With exactly one row there is nothing to
 * gain from the dynamic form, and a dynamic clause has to track parameter
 * indices — the classic place where a merge silently writes the wrong column.
 */
export class PostgresSettingsRepository implements SettingsRepository {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<DeploymentSettings> {
    // Materialise on read as well as in the migration, so a deployment whose
    // schema predates this table converges instead of erroring.
    await this.pool.query(
      'INSERT INTO deployment_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING',
    );
    const result = await this.pool.query<SettingsRow>(
      `SELECT ${SETTINGS_COLUMNS} FROM deployment_settings WHERE id = true`,
    );
    const row = result.rows[0];
    if (!row) {
      throw new InternalError('deployment_settings row is missing');
    }
    return toSettings(row);
  }

  async update(patch: DeploymentSettingsPatch): Promise<DeploymentSettings> {
    const next: DeploymentSettings = { ...(await this.get()), ...withoutUndefined(patch) };
    await this.pool.query(
      `UPDATE deployment_settings SET
         organization_name = $1, gateway_client_id = $2, gateway_webhook_secret_sealed = $3,
         adaptor_id = $4, adaptor_realm_id = $5, adaptor_base_url = $6,
         adaptor_credentials_sealed = $7, sync_interval = $8, alert_target = $9,
         verified_at = $10, configured_at = $11,
         invoice_match_strategy = $12, invoice_match_mode = $13,
         invoice_match_field = $14, payment_deposit_account_id = $15,
         updated_at = now()
       WHERE id = true`,
      [
        next.organizationName,
        next.gatewayClientId,
        next.gatewayWebhookSecret,
        next.adaptorId,
        next.adaptorRealmId,
        next.adaptorBaseUrl,
        next.adaptorCredentials,
        next.syncInterval,
        next.alertTarget,
        next.verifiedAt,
        next.configuredAt,
        next.invoiceMatchStrategy,
        next.invoiceMatchMode,
        next.invoiceMatchField,
        next.paymentDepositAccountId,
      ],
    );
    return this.get();
  }
}

/** Build a full set of Postgres repositories over the given pool. */
export function createPostgresRepositories(pool: Pool): Repositories {
  return {
    users: new PostgresUserRepository(pool),
    invites: new PostgresInviteRepository(pool),
    twoFactor: new PostgresTwoFactorRepository(pool),
    passwordResets: new PostgresPasswordResetRepository(pool),
    events: new PostgresEventRepository(pool),
    failures: new PostgresFailureRepository(pool),
    webhookDedup: new PostgresWebhookDedupRepository(pool),
    reconciliation: new PostgresReconciliationRepository(pool),
    connectorStates: new PostgresConnectorStateRepository(pool),
    payments: new PostgresPaymentRepository(pool),
    settings: new PostgresSettingsRepository(pool),
  };
}
