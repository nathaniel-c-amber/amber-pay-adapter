import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Size-rotated log file sink.
 *
 * WHY THIS EXISTS: the API logged only to stdout, so the log lived exactly as
 * long as the container did — `docker compose down` erased the only record of
 * what the process had reported. A durable file sink makes the log greppable
 * across restarts and shippable off-host.
 *
 * DELIBERATELY DEPENDENCY-FREE AND SYNCHRONOUS.
 *  - No new dependency: the alternative (`pino-roll`/`rotating-file-stream`)
 *    would add a package to a runtime image that is already `npm ci --omit=dev`.
 *  - Synchronous writes: log volume here is human-scale (a few lines per
 *    request), and sync writes make ordering deterministic — an async stream
 *    would need `flush()` coordination on rotation, which is exactly the sort
 *    of race that loses the lines you need after a crash.
 *  - `write()` NEVER THROWS. This object is a pino destination: an exception
 *    escaping it would either abort the write of an unrelated log line or, if
 *    emitted as a stream 'error' event, take the process down. A log sink that
 *    can kill the server it is observing is worse than no log sink, so every
 *    failure is swallowed after being reported once via `onUnavailable`.
 *
 * The fallback is the point: an unwritable log directory (a read-only
 * filesystem, a volume owned by another user) must degrade to stdout-only
 * logging, never to a process that will not boot.
 */

export interface LogFileOptions {
  /** Directory holding the log file. Created if absent. */
  dir: string;
  /** Base file name, e.g. `server.log`. Rotated copies become `server.log.1`. */
  fileName: string;
  /** Rotate when the active file would exceed this many bytes. */
  maxBytes: number;
  /** Total files to retain, including the active one (minimum 1). */
  maxFiles: number;
}

export class RotatingLogFile {
  private fd: number | null = null;
  private bytes = 0;
  /** Set once the sink proved unusable, so we stop retrying every log line. */
  private unavailable = false;
  private reportedUnavailable = false;

  constructor(
    private readonly options: LogFileOptions,
    /** Called at most once, with the reason, when the sink cannot be used. */
    private readonly onUnavailable?: (reason: string) => void,
  ) {}

  get path(): string {
    return join(this.options.dir, this.options.fileName);
  }

  /** Bytes written to the active file since it was opened or rotated. */
  get currentBytes(): number {
    return this.bytes;
  }

  /**
   * Open (or create) the active log file. Returns false when the sink is
   * unusable — the caller logs that fact to stdout and carries on.
   */
  open(): boolean {
    return this.ensureOpen();
  }

  /**
   * Append one chunk. Never throws: a failed write is reported once and then
   * the sink goes quiet rather than disrupting the process it is logging.
   */
  write(chunk: string): void {
    const size = Buffer.byteLength(chunk);
    if (!this.ensureOpen()) {
      return;
    }
    if (this.bytes > 0 && this.bytes + size > this.options.maxBytes) {
      this.rotate();
      if (!this.ensureOpen()) {
        return;
      }
    }
    try {
      writeSync(this.fd as number, chunk);
      this.bytes += size;
    } catch (err) {
      this.markUnavailable(err);
    }
  }

  /** Close the file handle. Writes after this reopen it (used by tests). */
  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Nothing useful to do: the handle is being discarded either way.
      }
      this.fd = null;
    }
  }

  private ensureOpen(): boolean {
    if (this.fd !== null) {
      return true;
    }
    if (this.unavailable) {
      return false;
    }
    try {
      mkdirSync(this.options.dir, { recursive: true });
      const existing = existsSync(this.path) ? statSync(this.path).size : 0;
      // Check size BEFORE opening for append: a file that grew past the limit
      // while the process was down should rotate now, not after another
      // `maxBytes` of traffic.
      if (existing > 0 && existing >= this.options.maxBytes) {
        this.rotateFiles();
        this.bytes = 0;
      } else {
        this.bytes = existing;
      }
      this.fd = openSync(this.path, 'a');
      return true;
    } catch (err) {
      this.markUnavailable(err);
      return false;
    }
  }

  /** Rename the active file out of the way, keeping at most `maxFiles` total. */
  private rotate(): void {
    try {
      this.close();
      this.rotateFiles();
      this.bytes = 0;
    } catch (err) {
      // A failed rename must not stop the next write: reopen in append mode and
      // let the file grow past the limit rather than dropping log lines.
      this.onUnavailable?.(`log rotation failed: ${describe(err)}`);
    }
  }

  private rotateFiles(): void {
    const base = this.path;
    const keep = Math.max(1, this.options.maxFiles);
    if (keep === 1) {
      // Only the active file is retained, so "rotation" is a truncation.
      rmSync(base, { force: true });
      return;
    }
    // Highest index first, so each rename lands on a slot that just vacated.
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = index === 1 ? base : `${base}.${index - 1}`;
      const to = `${base}.${index}`;
      if (!existsSync(from)) {
        continue;
      }
      rmSync(to, { force: true });
      renameSync(from, to);
    }
  }

  private markUnavailable(err: unknown): void {
    this.unavailable = true;
    this.close();
    if (!this.reportedUnavailable) {
      this.reportedUnavailable = true;
      this.onUnavailable?.(describe(err));
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
