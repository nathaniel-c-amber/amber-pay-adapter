/* Verifying an accounting connection, on the one path that must not leave a trace.
 *
 * THE POINT OF THIS FILE IS WHAT IT DOES NOT DO. The obvious way to test
 * credentials is the probe the console already runs (`probeAdaptors`), and using
 * it here would be actively harmful: that path records adaptor lifecycle events
 * and raises findings. An operator typing a password, making one typo and seeing
 * it rejected would thus raise a critical finding about a credential that is
 * ABOUT TO BE CORRECTED — noise that outlives the mistake, in the list nobody can
 * distinguish from a real outage. Verification is a question, not an observation.
 *
 * It also never touches the registry's CACHED instance. `get()` returns the
 * instance production connects, probes and pushes through, so trying a mistyped
 * credential against it would replace a working connection with a broken one: the
 * wizard would damage the very thing it was asked to check. `createAdaptor()`
 * builds a throwaway, and it is discarded whether the answer was yes or no.
 *
 * NOTHING HERE PERSISTS. A successful verification is a fact the CALLER may
 * choose to record (see the settings controller); this returns an answer and
 * keeps no state, so a test can assert that a failed attempt changed nothing.
 */

import { failureReasonForError } from '../adaptors/errors.js';
import { adaptorRegistry } from '../adaptors/registry.js';
import type { AdaptorRegistry } from '../adaptors/registry.js';
import type {
  AdaptorCredentials,
  AdaptorFailureReason,
  AdaptorId,
} from '../../types/adaptor.js';

/**
 * The verdict, as data.
 *
 * `reason` is a value rather than prose because the console needs to tell "the
 * provider rejected these credentials" from "the network is down" to say anything
 * useful — the first means fix the value, the second means try again later — and
 * matching on a message would break the moment someone reworded it. `message`
 * carries the adaptor's own explanation, which is already written to be read by
 * an operator.
 */
export interface AdaptorVerification {
  ok: boolean;
  adaptorId: AdaptorId;
  latencyMs: number;
  message: string;
  /** Null on success. */
  reason: AdaptorFailureReason | null;
  /**
   * Fields the upstream replaced during the attempt — QuickBooks rotates its
   * refresh token on every exchange, so a caller that persists nothing after a
   * SUCCESSFUL verification of STORED credentials must still store this, or the
   * next restart presents a token that has already been spent.
   */
  rotated: AdaptorCredentials | null;
}

/**
 * Connect to an accounting system with the supplied credentials and report
 * whether it answered.
 *
 * Report rather than throw: a rejected credential is the EXPECTED outcome of an
 * operator typing one, not an exception. Throwing would push every caller into
 * try/catch to read a boolean.
 */
export async function verifyAdaptorConnection(
  adaptorId: AdaptorId,
  credentials: AdaptorCredentials,
  registry: AdaptorRegistry = adaptorRegistry,
): Promise<AdaptorVerification> {
  // A throwaway instance — see the file header. Never `get()` here.
  const adaptor = registry.createAdaptor(adaptorId);
  const startedAt = Date.now();

  try {
    const result = await adaptor.connect(credentials);
    const rotated = result?.rotated ?? null;
    const health = await adaptor.healthCheck();

    return {
      ok: health.ok,
      adaptorId,
      latencyMs: health.latencyMs,
      message:
        health.message ??
        (health.ok ? 'The accounting system accepted the connection' : 'The accounting system did not answer'),
      // A failing probe that named no reason is still a failure this process
      // cannot attribute — `upstream` is the honest answer, not a guess at 'auth'.
      reason: health.ok ? null : (health.reason ?? 'upstream'),
      rotated,
    };
  } catch (err) {
    return {
      ok: false,
      adaptorId,
      // The elapsed time of a FAILED attempt, not a placeholder zero: "no answer
      // after 5021 ms" is what tells an operator apart a wrong password from a
      // firewall.
      latencyMs: Date.now() - startedAt,
      message:
        err instanceof Error ? err.message : 'The connection to the accounting system could not be established',
      reason: failureReasonForError(err),
      rotated: null,
    };
  } finally {
    /*
      Release whatever the attempt opened. A discarded instance is not collected
      promptly enough to rely on for a socket, and this one held credentials for
      the few seconds it existed. Failure to tidy up is not the caller's problem,
      so it is swallowed deliberately.
    */
    void adaptor.disconnect().catch(() => undefined);
  }
}
