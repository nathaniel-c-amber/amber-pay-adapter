import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Environment schema. Required vars fail fast on missing/invalid values;
 * optional vars fall back to sensible defaults.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

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

  // QuickBooks
  QUICKBOOKS_CLIENT_ID: z.string().optional(),
  QUICKBOOKS_CLIENT_SECRET: z.string().optional(),
  QUICKBOOKS_BASE_URL: z.string().url().optional(),
  QUICKBOOKS_REALM_ID: z.string().optional(),

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

export const env = parsed.data;

/** Comma-separated CORS allowlist -> array of origins for the CORS middleware. */
export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
