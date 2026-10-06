import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createLogStreams, redactPathsFor, redactedKeyNames } from './logger.js';

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

/**
 * THE SHIPPED REDACT LIST, asserted rather than assumed.
 *
 * These tests build a pino from the application's OWN paths. The test above
 * that constructs `pino({redact:{paths:['password']}})` proves only that pino
 * redacts what a test told it to; this one proves the list the application
 * actually ships protects the values the application actually handles.
 */
describe('the shipped redact list', () => {
  function loggerWithShippedRedaction() {
    const { streams } = loggerFor({ dir });
    return pino(
      { level: 'info', redact: { paths: redactPathsFor(redactedKeyNames), censor: '[REDACTED]' } },
      pino.multistream(streams, { dedupe: false }),
    );
  }

  it('removes the figures from a payment body sent to the accounting system', () => {
    /*
      The pipeline writes a body that QuickBooks REQUIRES: a total and a line
      amount, both of which are the invoice's outstanding balance. They exist
      in `quickbooksWire.ts` and nowhere else, and the guarantee that they do
      not reach a log line is this test.
    */
    const logger = loggerWithShippedRedaction();
    logger.info(
      {
        url: 'https://quickbooks.api.intuit.com/v3/company/9341457936805547/payment',
        body: {
          TotalAmt: 482.5,
          CustomerRef: { value: '17' },
          Line: [{ Amount: 482.5, LinkedTxn: [{ TxnId: '238', TxnType: 'Invoice' }] }],
          PaymentRefNum: 'tx-9f2a',
        },
      },
      'QuickBooks payment created',
    );

    const contents = readFileSync(join(dir, 'server.log'), 'utf8');
    expect(contents).toContain('QuickBooks payment created');
    expect(contents).not.toContain('482.5');
    // The transaction it was applied to, and the reference that makes a retry
    // recognisable, are operational and must SURVIVE — over-redaction would
    // make the log useless for the only thing it is for.
    expect(contents).toContain('238');
    expect(contents).toContain('tx-9f2a');
    /*
      The customer it was applied to, likewise. `value` was briefly on the
      redact list on the theory that every `*.Ref.value` is sensitive, and this
      assertion is why that was reverted: a QuickBooks reference id is exactly
      the category the domain model already permits (`externalInvoiceId` is
      documented as an external reference hash/id), and it is the one field that
      makes this line answer "who did we pay". Redacting it protected nobody
      and left an operator with a payment write they could not attribute.
    */
    expect(contents).toContain('"value":"17"');
  });

  it('removes the balance from a read response', () => {
    const logger = loggerWithShippedRedaction();
    logger.info({ Invoice: { Id: '238', Balance: 1200.75 } }, 'invoice read');

    const contents = readFileSync(join(dir, 'server.log'), 'utf8');
    expect(contents).not.toContain('1200.75');
  });

  it('removes figures and tokens at one and two levels of nesting', () => {
    /*
      pino's `*` spans exactly one level, so a list that names only the bare
      key protects nothing the moment the value is nested — which is exactly
      how an accounting response arrives.
    */
    const logger = loggerWithShippedRedaction();
    logger.info(
      { attempt: { totalAmt: 99, credentials: { accessToken: 'tok_live_abc' } } },
      'attempt failed',
    );

    const contents = readFileSync(join(dir, 'server.log'), 'utf8');
    /*
      KEY + VALUE, never the bare `'99'`.

      pino writes `time` (a ms epoch) and `pid` on EVERY line, so a two-digit
      substring collides with that metadata: this assertion failed or passed
      according to the wall clock, with no code change at all — "…929223742"
      contains "99". That hides the real failure mode, which is a redaction
      regression, behind a coin toss. Name the field being protected instead —
      `99` unquoted is what pino emits for a number that escaped redaction.
    */
    expect(contents).not.toContain('"totalAmt":99');
    expect(contents).not.toContain('tok_live_abc');
  });

  it('names the accounting spellings, not only the abstract one', () => {
    // The list is expanded from names, so a field the API spells differently
    // cannot be added to the data without also being added here.
    expect(redactedKeyNames).toEqual(
      expect.arrayContaining(['amount', 'totalAmt', 'TotalAmt', 'balance', 'Balance', 'unappliedAmt']),
    );
  });
});
