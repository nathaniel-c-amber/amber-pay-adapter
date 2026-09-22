import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { getPool } from './pool.js';

/**
 * Locate the migrations folder. `npm`/`node` are run from the `server/` root,
 * so we look for the compiled copy first, then the source copy. (A build-copy
 * step for `dist/db/migrations` is deferred.)
 */
function resolveMigrationsDir(): string {
  const distDir = path.join(process.cwd(), 'dist', 'db', 'migrations');
  const srcDir = path.join(process.cwd(), 'src', 'db', 'migrations');
  if (existsSync(distDir)) {
    return distDir;
  }
  if (existsSync(srcDir)) {
    return srcDir;
  }
  return srcDir;
}

function listMigrationFiles(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) {
    throw new Error(`Migrations folder not found: ${migrationsDir}`);
  }
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Apply pending migrations in filename order, tracking applied ones in the
 * `schema_migrations` table. Safe to run repeatedly (idempotent).
 */
export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  const migrationsDir = resolveMigrationsDir();

  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const appliedResult = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(appliedResult.rows.map((row) => row.name));

  const appliedNow: string[] = [];
  for (const file of listMigrationFiles(migrationsDir)) {
    if (applied.has(file)) {
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      appliedNow.push(file);
      logger.info({ migration: file }, 'Migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, migration: file }, 'Migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  return appliedNow;
}
