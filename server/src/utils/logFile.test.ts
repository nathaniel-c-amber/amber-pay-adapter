import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingLogFile } from './logFile.js';

/**
 * The file sink is the thing that makes the log outlive the container, so its
 * two dangerous failure modes are covered here explicitly: losing the log when
 * it rotates, and taking the process down when the log cannot be written.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amber-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sink(overrides: Partial<ConstructorParameters<typeof RotatingLogFile>[0]> = {}) {
  return new RotatingLogFile({
    dir,
    fileName: 'server.log',
    maxBytes: 1024,
    maxFiles: 3,
    ...overrides,
  });
}

describe('RotatingLogFile', () => {
  it('appends lines and tracks the size', () => {
    const log = sink();
    expect(log.open()).toBe(true);
    log.write('one\n');
    log.write('two\n');
    log.close();

    expect(readFileSync(log.path, 'utf8')).toBe('one\ntwo\n');
    expect(log.currentBytes).toBe(8);
  });

  it('creates the directory when it does not exist yet', () => {
    const log = sink({ dir: join(dir, 'nested', 'logs') });
    expect(log.open()).toBe(true);
    log.write('x\n');
    log.close();

    expect(readFileSync(join(dir, 'nested', 'logs', 'server.log'), 'utf8')).toBe('x\n');
  });

  it('rotates instead of growing past the limit', () => {
    const log = sink({ maxBytes: 10 });
    log.open();
    log.write('0123456789\n'); // exactly at the limit
    log.write('second\n'); // pushes past it

    expect(readdirSync(dir).sort()).toEqual(['server.log', 'server.log.1']);
    expect(readFileSync(join(dir, 'server.log.1'), 'utf8')).toBe('0123456789\n');
    expect(readFileSync(log.path, 'utf8')).toBe('second\n');
    log.close();
  });

  it('keeps at most `maxFiles` files, dropping the oldest', () => {
    const log = sink({ maxBytes: 5, maxFiles: 3 });
    log.open();
    for (let i = 0; i < 6; i += 1) {
      log.write(`line${i}\n`);
    }
    log.close();

    // 3 files total: the active one plus two rotated copies.
    expect(readdirSync(dir).sort()).toEqual(['server.log', 'server.log.1', 'server.log.2']);
    // The newest rotated copy holds the previous write.
    expect(readFileSync(join(dir, 'server.log.1'), 'utf8')).toBe('line4\n');
  });

  it('rotates an oversized file at open, so a restarted process does not append to it', () => {
    writeFileSync(join(dir, 'server.log'), 'x'.repeat(20));
    const log = sink({ maxBytes: 10 });
    expect(log.open()).toBe(true);
    log.write('fresh\n');
    log.close();

    expect(readFileSync(join(dir, 'server.log'), 'utf8')).toBe('fresh\n');
    expect(readFileSync(join(dir, 'server.log.1'), 'utf8')).toBe('x'.repeat(20));
  });

  it('reports an unusable directory once, and never throws on later writes', () => {
    // A FILE where the log directory should be: mkdir fails with ENOTDIR/EEXIST.
    const notADirectory = join(dir, 'blocked');
    writeFileSync(notADirectory, 'not a directory');
    const reasons: string[] = [];

    const log = new RotatingLogFile(
      { dir: notADirectory, fileName: 'server.log', maxBytes: 1024, maxFiles: 3 },
      (reason) => reasons.push(reason),
    );

    expect(log.open()).toBe(false);
    expect(reasons).toHaveLength(1);

    // Every later log line still has to be a no-op rather than an exception:
    // this object is a pino destination, and a throwing destination is a
    // process that cannot log its own failure.
    expect(() => log.write('still fine\n')).not.toThrow();
    expect(reasons).toHaveLength(1);
  });
});
