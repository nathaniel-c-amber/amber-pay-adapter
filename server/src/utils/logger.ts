import pino from 'pino';
import pinoHttp from 'pino-http';
import type { HttpLogger, Options } from 'pino-http';
import type { Level, StreamEntry } from 'pino';
import { env } from '../config/env.js';
import { RotatingLogFile } from './logFile.js';

const isDev = env.NODE_ENV === 'development';

/**
 * Key names whose values must never reach a log sink.
 *
 * LISTED ONCE AND EXPANDED, because the list was wrong in a way a comment
 * would not have caught: it named `amount`, and the accounting API this
 * adapter talks to spells the same thing `TotalAmt` on a write and `Balance`
 * on a read. A redactor that matches the concept but not the wire spelling
 * protects nothing — the value is in the body either way. Every name here is
 * therefore emitted bare, one level deep and two levels deep, because pino's
 * `*` matches a single level and an upstream body nests.
 *
 * CAPITALISED AND LOWERCASE PAIRS ARE BOTH SPELLED OUT, never derived. QuickBooks'
 * own casing is the contract, and the test in `logger.test.ts` is what holds
 * the two spellings honest — `Line[0].Amount` survived while `TotalAmt` beside
 * it was caught, which is the exact failure a "the list covers amounts" comment
 * would have shipped through.
 *
 * WHAT IS DELIBERATELY NOT LISTED: `value`. It was here on the theory that
 * QBO's `*.Ref.value` is sensitive, and that is wrong. A reference id is the
 * category the domain model already permits — `Invoice.externalInvoiceId` is
 * documented as "External reference hash / id (e.g. QuickBooks)" — and the
 * customer id is the one field that makes a payment log line answer "who did
 * we pay", which is the only question it exists for. Redacting it protects no
 * one and blinds the operator.
 */
const REDACTED_KEYS = [
  // Existing privacy surface: credentials and identity.
  'password',
  'secret',
  'token',
  'card',
  'email',
  'ref',
  // Financial values, under every spelling the accounting API uses.
  'amount',
  'Amount',
  'total',
  'totalAmt',
  'TotalAmt',
  'balance',
  'Balance',
  'unappliedAmt',
  'UnappliedAmt',
  'price',
  'currency',
  'CurrencyRef',
  // Credentials the onboarding wizard writes, plus the QBO transaction they
  // authenticate. A log line carrying a bearer token is the worst of these.
  'secretsKey',
  'clientSecret',
  'webhookSecret',
  'accessToken',
  'refreshToken',
  'adaptorCredentials',
  'credentials',
] as const;

/**
 * `key`, `*.key`, `*.*.key` … to `MAX_REDACT_DEPTH`.
 *
 * THE DEPTH IS NOT PARANOIA — IT WAS A BUG. The list named `amount`, and a
 * QuickBooks payment body carries it as `TotalAmt` (caught) and as
 * `Line[0].Amount` (NOT caught). pino's `*` matches one object level, and an
 * array element is reached by index, so a body nested one level deeper than the
 * path list assumed wrote the figure to disk in plain text. The test that
 * caught it is `utils/logger.test.ts`; the depth below is its fix.
 *
 * Broadening the DEPTH is safe in a way broadening the KEY list is not:
 * redaction matches on the key's name, so a deeper path only ever reaches
 * something called `amount` or `totalAmt`. `LinkedTxn.TxnId` — which the same
 * test asserts must survive, because it is the one operational handle on the
 * write — is untouched at any depth.
 */
const MAX_REDACT_DEPTH = 3;

function redactPaths(keys: readonly string[]): string[] {
  return keys.flatMap((key) =>
    Array.from({ length: MAX_REDACT_DEPTH + 1 }, (_, depth) =>
      depth === 0 ? key : `${Array.from({ length: depth }, () => '*').join('.')}.${key}`,
    ),
  );
}

/**
 * The shipped redact list, exported so a test can assert it.
 *
 * EXPORTED, not merely used, because the list is a security control and the
 * suite could otherwise only reach it by constructing its own logger with its
 * own paths — which proves the test's list works, not the shipped one. A
 * control nothing asserts is a control that decays silently.
 */
export const redactPathsFor = redactPaths;
export const redactedKeyNames: readonly string[] = REDACTED_KEYS;

const baseOptions = {
  level: env.LOG_LEVEL,
  // Privacy guarantee: never log sensitive keys. Redact them from any log
  // payload (including pino-http request/response serialization).
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      ...redactPaths(REDACTED_KEYS),
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
