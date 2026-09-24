import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createLogStreams } from './logger.js';

/**
 * The fan-out wiring: stdout stays the primary sink and the file is an
 * ADDITIONAL durable copy. A regression here is silent — the app keeps
 * answering while the log quietly stops being written anywhere durable.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amber-logger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function loggerFor(opts: { dir: string; onUnavailable?: (reason: string) => void }) {
  return createLogStreams({
    level: 'info',
    // No stdout: the assertion is about the file, and the suite's own output
    // should not fill with NDJSON.
    pretty: false,
    toStdout: false,
    toFile: true,
    file: { dir: opts.dir, fileName: 'server.log', maxBytes: 1024 * 1024, maxFiles: 2 },
    ...(opts.onUnavailable === undefined ? {} : { onUnavailable: opts.onUnavailable }),
  });
}

describe('createLogStreams', () => {
  it('writes log lines to the file when a file sink is enabled', () => {
    const { streams, fileSink } = loggerFor({ dir });
    expect(fileSink).not.toBeNull();

    const logger = pino({ level: 'info' }, pino.multistream(streams, { dedupe: false }));
    logger.info({ probe: 'file-sink' }, 'written to disk');

    const contents = readFileSync(join(dir, 'server.log'), 'utf8');
    expect(contents).toContain('written to disk');
    expect(contents).toContain('file-sink');
  });

  it('redacts sensitive keys in the file copy as well as on stdout', () => {
    // The redact config lives on the logger, so a second sink must not be a way
    // around the privacy rule (FR-5.2).
    const { streams } = loggerFor({ dir });
    const logger = pino(
      { level: 'info', redact: { paths: ['password'], censor: '[REDACTED]' } },
      pino.multistream(streams, { dedupe: false }),
    );
    logger.info({ password: 'hunter2' }, 'sign-in attempt');

    const contents = readFileSync(join(dir, 'server.log'), 'utf8');
    expect(contents).toContain('[REDACTED]');
    expect(contents).not.toContain('hunter2');
  });

  it('degrades to stdout-only when the log path is unusable', () => {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const reasons: string[] = [];

    const { streams, fileSink } = loggerFor({ dir: blocked, onUnavailable: (r) => reasons.push(r) });

    expect(fileSink).toBeNull();
    expect(streams).toHaveLength(0); // no stdout, no file — nothing left to write to
    expect(reasons).toHaveLength(1);
  });
});
