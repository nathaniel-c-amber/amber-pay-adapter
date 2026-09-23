import { env } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { getRepositories, isDatabaseConfigured } from './repositories/index.js';
import { runMigrations } from './db/migrator.js';
import { seedSuperAdmin } from './db/seed.js';
import { closePool } from './db/pool.js';
import { connectConfiguredAdaptors } from './services/adaptors/health.service.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function start(): Promise<void> {
  // Apply pending migrations when a database is configured. Tests and DB-less
  // runs use the in-memory repositories and skip this entirely.
  if (isDatabaseConfigured()) {
    try {
      const applied = await runMigrations();
      logger.info({ applied }, 'Database migrations up to date');

      // Seed a super admin on install when configured (idempotent).
      const seeded = await seedSuperAdmin(getRepositories());
      if (seeded) {
        logger.info('Super admin seeded on install');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to run database migrations');
      process.exit(1);
    }
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  /*
    Establish the accounting connections, without blocking startup and without
    taking the API down if an upstream is unreachable: the console's whole job
    is to report on that link, so it must be able to serve while the link is
    broken. Each adaptor logs its own outcome (see `connectConfiguredAdaptors`).
  */
  void connectConfiguredAdaptors();

  function shutdown(signal: string): void {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Force-exit if graceful shutdown hangs (e.g. lingering connections).
    const forceExit = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close((err) => {
      clearTimeout(forceExit);
      if (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
      void closePool().finally(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});

void start();
