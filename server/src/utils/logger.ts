import pino from 'pino';
import pinoHttp from 'pino-http';
import type { HttpLogger, Options } from 'pino-http';
import type { Level, StreamEntry } from 'pino';
import { env } from '../config/env.js';
import { RotatingLogFile } from './logFile.js';

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
      // Credentials the onboarding wizard writes. Redacted by NAME as well as by
      // pino's wildcard path match: these are the values whose leak would be
      // worst, and a log line that includes a field called `webhookSecret` is
      // exactly the accident this list exists to prevent.
      'secretsKey',
      'clientSecret',
      'webhookSecret',
      'adaptorCredentials',
      'credentials',
      '*.secretsKey',
      '*.clientSecret',
      '*.webhookSecret',
      '*.adaptorCredentials',
      '*.credentials',
    ],
    censor: '[REDACTED]',
  },
};

export interface LogFileConfig {
  dir: string;
  fileName: string;
  maxBytes: number;
  maxFiles: number;
}

export interface LogStreamsOptions {
  /** Base level applied to every sink. */
  level: Level;
  /**
   * Human-readable stdout (dev). Off = raw NDJSON, which is what a log
   * collector expects to parse.
   */
  pretty: boolean;
  toStdout: boolean;
  toFile: boolean;
  file: LogFileConfig;
  /** Reported once, to stderr, when the file sink cannot be used. */
  onUnavailable?: (reason: string) => void;
}

export interface LogStreams {
  streams: StreamEntry[];
  /** The file sink, when one was opened — null in stdout-only mode. */
  fileSink: RotatingLogFile | null;
}

/**
 * Build the logger's fan-out: stdout, plus an optional rotating file.
 *
 * Extracted from the singleton so the file wiring is testable without writing
 * into the repository or re-importing the env-parsing module.
 *
 * FAN-OUT, NOT REPLACEMENT. stdout stays the primary sink on purpose: that is
 * what `docker compose logs` reads, and dropping it to "log to a file" would
 * make every existing operational habit blind. The file is an additional
 * durable copy, and it is the copy that survives the container.
 */
export function createLogStreams(options: LogStreamsOptions): LogStreams {
  const streams: StreamEntry[] = [];

  if (options.toStdout) {
    streams.push({ level: options.level, stream: stdoutStream(options.pretty) });
  }

  let fileSink: RotatingLogFile | null = null;
  if (options.toFile) {
    const sink = new RotatingLogFile(options.file, options.onUnavailable);
    // `open()` IS the availability check: an unwritable directory is a
    // configuration fact, not a per-line failure, so it is decided once at
    // startup and reported to the operator.
    if (sink.open()) {
      fileSink = sink;
      streams.push({ level: options.level, stream: { write: (msg: string) => sink.write(msg) } });
    }
  }

  return { streams, fileSink };
}

/**
 * stdout sink. In development the lines are colourised for a human; anywhere
 * else they stay raw NDJSON, which a log collector can parse without stripping
 * escape codes.
 */
function stdoutStream(pretty: boolean): { write(msg: string): void } {
  if (!pretty) {
    return process.stdout;
  }
  try {
    return pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    });
  } catch {
    // pino-pretty is a dev-only dependency and may be absent (e.g. a runtime
    // image built with `npm ci --omit=dev`). Fall back to plain JSON so the
    // app still starts instead of crashing on an unavailable transport.
    return process.stdout;
  }
}

function createLogger(): pino.Logger {
  const { streams } = createLogStreams({
    level: baseOptions.level as Level,
    pretty: isDev,
    toStdout: true,
    // Tests must not litter the repository with log files, and a test run
    // already has its own console output to read.
    toFile: env.LOG_TO_FILE && env.NODE_ENV !== 'test',
    file: {
      dir: env.LOG_DIR,
      fileName: env.LOG_FILE_NAME,
      maxBytes: env.LOG_MAX_SIZE_BYTES,
      maxFiles: env.LOG_MAX_FILES,
    },
    onUnavailable: (reason) => {
      // Written straight to stderr: the logger is the thing being configured,
      // so it cannot report its own wiring failure.
      process.stderr.write(`[logger] file logging disabled: ${reason}\n`);
    },
  });

  return pino(baseOptions, pino.multistream(streams, { dedupe: false }));
}

export const logger = createLogger();

// pino-http ships CommonJS with an ESM-style `.d.ts`; under NodeNext the
// default import is typed as the module namespace, so cast to the callable.
const pinoHttpFactory = pinoHttp as unknown as (opts?: Options) => HttpLogger;

export const requestLogger: HttpLogger = pinoHttpFactory({ logger });
