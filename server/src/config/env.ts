import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Boolean env var.
 *
 * NOT `z.coerce.boolean()`: that is `Boolean(value)`, and `Boolean('false')` is
 * `true` — so `LOG_TO_FILE=false` would have silently switched file logging ON,
 * the opposite of what the operator asked for. Only these spellings count; an
 * empty value falls back to the default.
 */
function envBoolean(defaultValue: boolean) {
  const fallback = defaultValue ? 'true' : 'false';
  return z
    .enum(['true', 'false', '1', '0', ''])
    .default(fallback)
    .transform((value) => (value === '' ? defaultValue : value === 'true' || value === '1'));
}

/**
 * Environment schema. Required vars fail fast on missing/invalid values;
 * optional vars fall back to sensible defaults.
 */
/**
 * An empty string counts as ABSENT, not as a value.
 *
 * docker-compose renders `${VAR:-}` as an empty string when the root `.env`
 * leaves it blank, so a zod schema that format-checks an optional variable would
 * refuse to boot a deployment that simply does not use that feature.
 */
const blankAsAbsent = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().default(3300),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // --- File logging ------------------------------------------------------
  // The process always logs to stdout (docker/k8s collect that). This adds a
  // durable, size-rotated file sink as well, so the record survives a container
  // restart and can be read without attaching to the container.
  //
  // Off in tests: a test run must not write log files into the repository.
  LOG_TO_FILE: envBoolean(true),
  LOG_DIR: z.string().min(1).default('logs'),
  LOG_FILE_NAME: z.string().min(1).default('server.log'),
  // Rotate at 5 MiB and keep 5 files, so one instance is bounded at ~25 MiB.
  LOG_MAX_SIZE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  LOG_MAX_FILES: z.coerce.number().int().min(1).default(5),

  // Database (PostgreSQL 16)
  DATABASE_URL: z.string().min(1),

  // Auth (JWT + PBAC)
  JWT_SECRET: z.string().min(16),
  JWT_TTL: z.string().default('1h'),
  // Invitation link lifetime (FR-1.3).
  INVITE_TTL: z.string().default('48h'),
  // Email 2FA challenge lifetime.
  TWO_FACTOR_TTL: z.string().default('5m'),
  // Self-service password-reset link lifetime. Short: the link is a bearer
  // credential delivered by email.
  PASSWORD_RESET_TTL: z.string().default('1h'),

  /*
    Credential encryption (see utils/secrets.ts).

    OPTIONAL today, because nothing stores a credential until the onboarding
    wizard lands — but a deployment that will hold credentials MUST set it, and
    `sealSecret` refuses to write rather than storing one in the clear.

    A 32-byte key as 64 hex characters. Generate with `openssl rand -hex 32`.
    Deliberately WITHOUT a default: a sample key that quietly encrypts a real
    credential is worse than no key at all.

    `blankAsAbsent` matters for all three: docker-compose passes `${VAR:-}` as an
    EMPTY STRING when the root `.env` leaves it blank, and zod treats a present
    empty string as a value. Without it, the format check would make every
    deployment that does not use credentials fail to boot.
  */
  SECRETS_KEY: z.preprocess(
    blankAsAbsent,
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')
      .optional(),
  ),
  /**
   * Labels the CURRENT key. The previous key's version is implied to be one
   * lower, so a rotation is "move the current key to PREVIOUS, set a new current,
   * and raise this number".
   */
  SECRETS_KEY_VERSION: z.preprocess(
    blankAsAbsent,
    z.coerce.number().int().min(1).max(255).default(1),
  ),
  /** Decrypt-only: keeps rows sealed before the last rotation readable. */
  SECRETS_KEY_PREVIOUS: z.preprocess(
    blankAsAbsent,
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')
      .optional(),
  ),

  // Super admin bootstrap (optional). When BOTH are set, a super admin user
  // (all privileges, all scopes/orgs) is seeded on install. Idempotent: an
  // existing user is never overwritten.
  SUPER_ADMIN_EMAIL: z.string().email().optional(),
  SUPER_ADMIN_PASSWORD: z.string().min(12).optional(),

  // Amber Pay
  AMBER_PAY_BASE_URL: z.string().url().default('https://api.amberpay.example.com'),
  // Required: webhook signature verification must never silently fall back to
  // an empty secret. Fails fast when webhooks land.
  AMBER_PAY_WEBHOOK_SECRET: z.string().min(1),

  // CORS allowlist (comma-separated origins). Defaults to the Vite dev server.
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /*
    The ONE organization this deployment serves (one deployment per organization).

    Load-bearing for correctness, not labelling. Every operational row is stored
    with this organization id, and reads are filtered by the organization ids
    NAMED IN THE CALLER'S POLICY. When a row's organization and a policy's
    organization disagree, the row is invisible to the very user it belongs to:
    the console reads empty while the backend works perfectly — and the only
    account that cannot see the problem is the wildcard super admin, whose
    wildcard scope bypasses the filter entirely.

    It lives in the environment because the webhook and adaptor-event paths write
    rows at boot, before any human has configured anything, so it must not depend
    on a settings row that may not exist yet.
  */
  ORGANIZATION_ID: z.string().min(1).default('default'),

  /*
    The ONE accounting system this deployment integrates with, chosen at setup.

    An organization integrates with exactly one, so this value selects what is
    probed, what the Connections page draws, and where a completed payment is
    pushed — three surfaces that previously each assumed BOTH adaptors existed.
    A QuickBooks-only organization was shown a suspended Sage route reading "Sage
    credentials are not configured": a fault that is not real, on the console's
    most important page.

    Stored configuration wins once the onboarding wizard has set a choice. The
    default preserves what the webhook push path previously hardcoded.
  */
  ADAPTOR_ID: z.preprocess(
    blankAsAbsent,
    z.enum(['quickbooks', 'sage']).default('quickbooks'),
  ),

  // Number of reverse proxies in front of this process (nginx in the compose
  // stack, plus ngrok when the tunnel profile is active).
  //
  // Load-bearing for rate limiting: with the default `false`, Express reports
  // the PROXY's address as `req.ip`, so every client shares one bucket and
  // express-rate-limit reports ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on each
  // throttled request. Do NOT raise it casually — a value higher than the real
  // hop count lets a client forge `X-Forwarded-For` and mint itself a fresh
  // rate-limit bucket.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

  // QuickBooks
  QUICKBOOKS_CLIENT_ID: z.string().optional(),
  QUICKBOOKS_CLIENT_SECRET: z.string().optional(),
  QUICKBOOKS_BASE_URL: z.string().url().optional(),
  QUICKBOOKS_REALM_ID: z.string().optional(),

  /*
    TRANSITIONAL — deprecated, and no longer offered by the setup wizard.

    A bearer token is what actually authorizes a call; a client id and secret alone
    cannot mint one, because a grant requires a human to consent. The wizard now
    obtains that grant in a browser and keeps the resulting refresh token, so nobody
    has to paste either of these.

    THEY REMAIN BECAUSE `credentials.provider.ts` still falls back to the
    environment for a deployment configured entirely from `.env`, and removing them
    would break every existing install on upgrade — a worse failure than two sources
    for a while. Delete this pair, and the fallback branch with it, once no install
    is configured this way any more.
  */
  QUICKBOOKS_ACCESS_TOKEN: z.string().optional(),
  QUICKBOOKS_REFRESH_TOKEN: z.string().optional(),

  /*
    Which Intuit environment the deployment talks to. EXPLICIT rather than inferred
    from the base URL, because the two environments are separate tenants with
    separate apps and separate companies: a sandbox token is valid at
    sandbox-quickbooks and produces a 401 at the production API, which reads as
    "the credentials are wrong" when they are perfectly valid. Naming the
    environment is what makes the wizard able to say which one it used.
  */
  QUICKBOOKS_ENVIRONMENT: z.preprocess(blankAsAbsent, z.enum(['sandbox', 'production']).default('production')),
  /*
    Where Intuit sends the browser back after consent. Defaults to
    `${APP_BASE_URL}/api/v1/settings/adaptor/callback` when unset, which is right
    for a one-deployment-per-organization install: the redirect URI is a property of
    the deployment's public address, not of the operator's machine.

    IT MUST BE REGISTERED with the Intuit app, and Intuit requires https except
    for `localhost`, which is permitted in the sandbox. That is the single most
    likely reason a connect attempt appears to fail with no error anywhere.
  */
  QUICKBOOKS_REDIRECT_URI: z.string().url().optional(),

  // Sage
  SAGE_CLIENT_ID: z.string().optional(),
  SAGE_CLIENT_SECRET: z.string().optional(),
  SAGE_BASE_URL: z.string().url().optional(),

  // Email (SMTP). When SMTP_HOST is set, invites and 2FA codes are delivered
  // via SMTP; otherwise delivery is stubbed (logged, never the body/code).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().optional(),
  SMTP_SECURE: z.enum(['starttls', 'ssl', 'none']).default('starttls'),
  // Base URL used to build the invite link in emails.
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

/**
 * Validate SMTP config together. When `SMTP_HOST` is set, `SMTP_FROM` is
 * required, and `SMTP_USER`/`SMTP_PASS` must be set together. Fails fast so a
 * misconfigured email setup is caught at startup. Exported so it can be
 * unit-tested directly.
 */
export function assertValidSmtpConfig(
  host: string | undefined,
  from: string | undefined,
  user: string | undefined,
  pass: string | undefined,
): void {
  if (!host) {
    return;
  }
  if (!from) {
    throw new Error('SMTP_FROM is required when SMTP_HOST is set');
  }
  if ((user && !pass) || (!user && pass)) {
    throw new Error('SMTP_USER and SMTP_PASS must be set together');
  }
}

assertValidSmtpConfig(
  parsed.data.SMTP_HOST,
  parsed.data.SMTP_FROM,
  parsed.data.SMTP_USER,
  parsed.data.SMTP_PASS,
);

/**
 * Known placeholder prefixes for secrets. These match the docker-compose /
 * `.env.example` defaults so a production deploy can never run with them.
 */
const PLACEHOLDER_SECRET_PREFIXES = ['change-me-'];

function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER_SECRET_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Fail fast when running in production with a known placeholder secret.
 * Dev/test are unaffected. Exported so it can be unit-tested directly without
 * re-importing this module (which parses process.env at load time).
 */
export function assertNoPlaceholderSecrets(
  nodeEnv: string,
  jwtSecret: string,
  webhookSecret: string,
  superAdminPassword?: string,
  smtpPass?: string,
): void {
  if (nodeEnv !== 'production') {
    return;
  }
  if (isPlaceholderSecret(jwtSecret)) {
    throw new Error('JWT_SECRET must not be a known placeholder value in production');
  }
  if (isPlaceholderSecret(webhookSecret)) {
    throw new Error('AMBER_PAY_WEBHOOK_SECRET must not be a known placeholder value in production');
  }
  if (superAdminPassword && isPlaceholderSecret(superAdminPassword)) {
    throw new Error('SUPER_ADMIN_PASSWORD must not be a known placeholder value in production');
  }
  if (smtpPass && isPlaceholderSecret(smtpPass)) {
    throw new Error('SMTP_PASS must not be a known placeholder value in production');
  }
}

assertNoPlaceholderSecrets(
  parsed.data.NODE_ENV,
  parsed.data.JWT_SECRET,
  parsed.data.AMBER_PAY_WEBHOOK_SECRET,
  parsed.data.SUPER_ADMIN_PASSWORD,
  parsed.data.SMTP_PASS,
);

/**
 * Secrets-key consistency.
 *
 * `SECRETS_KEY_VERSION` labels the CURRENT key and implies the previous key is
 * one version lower, so a previous key alongside version 1 describes a rotation
 * that never happened — and would make the "previous" key collide with the
 * current one's version. Caught here, at boot, rather than at the moment an
 * operator is trying to save a credential.
 */
export function assertValidSecretsConfig(version: number, previousKey?: string): void {
  if (previousKey && version < 2) {
    throw new Error(
      'SECRETS_KEY_PREVIOUS is set but SECRETS_KEY_VERSION is 1: raise the version when rotating',
    );
  }
}

assertValidSecretsConfig(parsed.data.SECRETS_KEY_VERSION, parsed.data.SECRETS_KEY_PREVIOUS);

export const env = parsed.data;

/** Comma-separated CORS allowlist -> array of origins for the CORS middleware. */
export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
