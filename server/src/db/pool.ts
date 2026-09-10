import { Pool } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

let pool: Pool | undefined;

/**
 * Lazily create the PostgreSQL connection pool. No connection is opened until
 * the first query, so importing this module never requires a live database.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL });
    // A pool error must not crash the process.
    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected PostgreSQL pool error');
    });
  }
  return pool;
}

/** Close the pool (used on graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
