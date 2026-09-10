import { env } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
});

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
    logger.info('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});
