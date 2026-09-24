import { adaptorRegistry } from './registry.js';
import { connectAdaptor } from './credentials.provider.js';
import { logger } from '../../utils/logger.js';
import { failureReasonForError } from './errors.js';
import { adaptorEventRecorder } from '../events/adaptorEventRecorder.service.js';
import type { AdaptorEventRecorder, AdaptorOutcome } from '../events/adaptorEventRecorder.service.js';
import type { AdaptorRegistry } from './registry.js';
import type { AccountingAdaptor, AdaptorFailureReason, AdaptorId } from '../../types/adaptor.js';

export interface ServiceStatusAdaptors {
  id: AdaptorId;
  name: string;
  status: string;
  reachable: boolean;
  latencyMs: number | null;
  message?: string;
}

/**
 * The last state an adaptor probe observed.
 *
 * Read by anything that needs to reflect the connection without paying for a
 * probe — the dashboard overlay below is the caller. Kept separate from
 * `AdaptorStatus` because "connected" alone does not say whether the upstream
 * actually answers, and those are different claims on screen.
 */
export interface AdaptorRuntimeState {
  status: string;
  reachable: boolean;
  message?: string;
  /** Round trip of the last probe, when one ran. */
  latencyMs?: number | null;
}

const lastKnown = new Map<AdaptorId, AdaptorRuntimeState>();

/** The most recent probed state per adaptor. Empty until a probe has run. */
export function lastKnownAdaptorStates(): ReadonlyMap<AdaptorId, AdaptorRuntimeState> {
  return lastKnown;
}

/**
 * How long to wait before re-attempting a connection that failed.
 *
 * The console polls this endpoint every few seconds, and a connection attempt
 * can be a network round trip (a refresh-token exchange). Retrying on every poll
 * would hammer Intuit with failing exchanges, so a failed attempt is remembered
 * for a minute; a successful one is never re-attempted, because `status()`
 * reports connected.
 */
const CONNECT_RETRY_MS = 60_000;

const lastConnectAttemptAt = new Map<AdaptorId, number>();

/**
 * Why the last connection attempt for an adaptor failed.
 *
 * Remembered because the connect attempt is THROTTLED (above), so most probes
 * in a minute do not re-attempt and therefore have no error of their own to
 * report. Without this, the second probe would describe a rejected-token
 * failure as a generic "not connected", which the event log would read as a
 * DIFFERENT problem and record again — one outage, two events, two findings.
 */
const lastConnectReason = new Map<AdaptorId, AdaptorFailureReason>();

/** Test seam: forget the retry throttle between cases. */
export function resetConnectAttempts(): void {
  lastConnectAttemptAt.clear();
  lastConnectReason.clear();
}

function shouldAttemptConnect(id: AdaptorId, now: number): boolean {
  const last = lastConnectAttemptAt.get(id);
  return last === undefined || now - last >= CONNECT_RETRY_MS;
}

/**
 * Probe every registered adaptor.
 *
 * CONNECT, DON'T JUST ASK. This used to call `status()` + `healthCheck()` on an
 * adaptor that nothing had ever connected — only the webhook push path called
 * `connect()`, and only when a payment arrived. So a deployment with perfectly
 * good credentials reported "not connected" from boot until the first payment,
 * and the operator's only recourse was to read the source. The probe now makes
 * the connection itself (throttled, above) and reports WHY when it cannot.
 *
 * These outcomes are deliberately distinct, because they need different fixes:
 *   - `disconnected` + "not configured"   → add credentials.
 *   - `disconnected` + "not authorized"   → add a token / complete the grant.
 *   - `connected`    + `reachable: false` → the connection works; the upstream
 *                                           or the token is unhappy.
 *
 * Every outcome is also handed to the event recorder, so what the service panel
 * shows is what the event log records. Without that, an adaptor could answer 401
 * on the Overview for days while the Event log page stayed empty — the exact
 * contradiction the console exists to prevent.
 *
 * The registry and recorder are injectable for the same reason every service
 * here takes its collaborators: a test must be able to drive a 401 from a fake
 * transport without reaching Intuit and without mocking the module graph.
 */
export async function probeAdaptors(
  registry: AdaptorRegistry = adaptorRegistry,
  recorder: AdaptorEventRecorder = adaptorEventRecorder,
): Promise<ServiceStatusAdaptors[]> {
  const ids = registry.list();
  const probes = await Promise.all(ids.map((id) => probeAdaptor(registry, id)));
  // Recorded as one batch once every probe has resolved: the outcomes are then
  // complete, and the recorder can decide "changed state" from a consistent set.
  await recorder.recordOutcomes(probes.map((probe) => probe.outcome));
  return probes.map((probe) => probe.status);
}

interface AdaptorProbe {
  status: ServiceStatusAdaptors;
  outcome: AdaptorOutcome;
}

async function probeAdaptor(registry: AdaptorRegistry, id: AdaptorId): Promise<AdaptorProbe> {
  const adaptor: AccountingAdaptor = registry.get(id);
  let connectError: string | null = null;
  let connectReason: AdaptorFailureReason | undefined;

  try {
    if ((await adaptor.status()) !== 'connected' && shouldAttemptConnect(id, Date.now())) {
      lastConnectAttemptAt.set(id, Date.now());
      try {
        // Through the provider, never `adaptor.connect()` directly: the adaptor
        // reads no environment, and the provider is what also persists a rotated
        // credential.
        await connectAdaptor(adaptor);
        lastConnectReason.delete(id);
      } catch (err) {
        connectError = err instanceof Error ? err.message : 'connection failed';
        connectReason = failureReasonForError(err);
        lastConnectReason.set(id, connectReason);
        logger.warn({ adaptor: id, reason: connectError }, 'Adaptor is not connected');
      }
    }

    if ((await adaptor.status()) !== 'connected') {
      // Reuse the remembered reason when this probe was throttled out of its own
      // attempt, so a failure keeps one identity across the whole retry window.
      const reason = connectReason ?? lastConnectReason.get(id) ?? 'unreachable';
      const message = connectError ?? 'adaptor is not connected';
      const state: AdaptorRuntimeState = {
        status: 'disconnected',
        reachable: false,
        message,
      };
      lastKnown.set(id, state);
      return {
        status: {
          id,
          name: adaptor.name,
          status: state.status,
          reachable: state.reachable,
          latencyMs: null,
          message: state.message,
        },
        outcome: { id, name: adaptor.name, reachable: false, reason, message },
      };
    }

    const health = await adaptor.healthCheck();
    lastKnown.set(id, {
      status: 'connected',
      reachable: health.ok,
      latencyMs: health.latencyMs,
      ...(health.message === undefined ? {} : { message: health.message }),
    });
    return {
      status: {
        id,
        name: adaptor.name,
        status: 'connected',
        reachable: health.ok,
        latencyMs: health.latencyMs,
        ...(health.message === undefined ? {} : { message: health.message }),
      },
      outcome: {
        id,
        name: adaptor.name,
        reachable: health.ok,
        ...(health.reason === undefined ? {} : { reason: health.reason }),
        ...(health.message === undefined ? {} : { message: health.message }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'health check failed';
    lastKnown.set(id, { status: 'error', reachable: false, message });
    return {
      status: { id, name: adaptor.name, status: 'error', reachable: false, latencyMs: null, message },
      outcome: {
        id,
        name: adaptor.name,
        reachable: false,
        reason: failureReasonForError(error),
        message,
      },
    };
  }
}

/**
 * Connect every registered adaptor once, at boot, without blocking startup.
 *
 * Nothing called `connect()` before this except the webhook push path, so the
 * console could only ever say "not connected", and the first payment was what
 * finally established (or failed to establish) the link. Logging the outcome at
 * boot gives an operator one line to read in `docker compose logs api`.
 *
 * Failures are also filed as lifecycle events: a container that boots against a
 * rejected QuickBooks token should say so in the event log, not only on stderr.
 * Successes are NOT filed — a successful `connect()` proves the credentials
 * were accepted, not that the upstream answers, and the first probe is what
 * establishes reachability.
 *
 * Never throws: an unreachable accounting system must not stop the API from
 * serving the console that reports on it.
 */
export async function connectConfiguredAdaptors(
  registry: AdaptorRegistry = adaptorRegistry,
  recorder: AdaptorEventRecorder = adaptorEventRecorder,
): Promise<void> {
  const failures: AdaptorOutcome[] = [];
  await Promise.all(
    registry.list().map(async (id) => {
      const adaptor = registry.get(id);
      try {
        await connectAdaptor(adaptor);
        lastConnectReason.delete(id);
        logger.info({ adaptor: id }, 'Adaptor connected on startup');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'connect failed';
        const reason = failureReasonForError(err);
        lastConnectReason.set(id, reason);
        logger.warn(
          { adaptor: id, reason: message, failureReason: reason },
          'Adaptor not connected on startup',
        );
        failures.push({ id, name: adaptor.name, reachable: false, reason, message });
      }
    }),
  );
  await recorder.recordOutcomes(failures);
}
