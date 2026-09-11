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

  // Notifications
  SENDGRID_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

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
}

assertNoPlaceholderSecrets(
  parsed.data.NODE_ENV,
  parsed.data.JWT_SECRET,
  parsed.data.AMBER_PAY_WEBHOOK_SECRET,
  parsed.data.SUPER_ADMIN_PASSWORD,
);

export const env = parsed.data;

/** Comma-separated CORS allowlist -> array of origins for the CORS middleware. */
export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
