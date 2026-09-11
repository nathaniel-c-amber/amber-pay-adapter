import pino from 'pino';
import pinoHttp from 'pino-http';
import type { HttpLogger, Options } from 'pino-http';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV === 'development';

const baseOptions = {
  level: env.LOG_LEVEL,
  // Privacy guarantee: never log sensitive keys. Redact them from any log
  // payload (including pino-http request/response serialization).
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'secret',
      'token',
      'card',
      'amount',
      'email',
      'ref',
      '*.password',
      '*.secret',
      '*.token',
      '*.card',
      '*.amount',
      '*.email',
      '*.ref',
    ],
    censor: '[REDACTED]',
  },
};

function createLogger() {
  if (!isDev) {
    return pino(baseOptions);
  }
  try {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  } catch {
    // pino-pretty is a dev-only dependency and may be absent (e.g. a runtime
    // image built with `npm ci --omit=dev`). Fall back to plain JSON so the
    // app still starts instead of crashing on an unavailable transport.
    return pino(baseOptions);
  }
}

export const logger = createLogger();

// pino-http ships CommonJS with an ESM-style `.d.ts`; under NodeNext the
// default import is typed as the module namespace, so cast to the callable.
const pinoHttpFactory = pinoHttp as unknown as (opts?: Options) => HttpLogger;

export const requestLogger: HttpLogger = pinoHttpFactory({ logger });
