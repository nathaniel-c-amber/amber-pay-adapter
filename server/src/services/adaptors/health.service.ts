import { adaptorRegistry } from './registry.js';
import { logger } from '../../utils/logger.js';
import type { AccountingAdaptor, AdaptorId } from '../../types/adaptor.js';

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

/** Test seam: forget the retry throttle between cases. */
export function resetConnectAttempts(): void {
  lastConnectAttemptAt.clear();
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
 */
export async function probeAdaptors(): Promise<ServiceStatusAdaptors[]> {
  const ids = adaptorRegistry.list();
  return Promise.all(
    ids.map(async (id): Promise<ServiceStatusAdaptors> => {
      const adaptor: AccountingAdaptor = adaptorRegistry.get(id);
      let connectError: string | null = null;

      try {
        if ((await adaptor.status()) !== 'connected' && shouldAttemptConnect(id, Date.now())) {
          lastConnectAttemptAt.set(id, Date.now());
          try {
            await adaptor.connect();
          } catch (err) {
            connectError = err instanceof Error ? err.message : 'connection failed';
            logger.warn({ adaptor: id, reason: connectError }, 'Adaptor is not connected');
          }
        }

        if ((await adaptor.status()) !== 'connected') {
          const state: AdaptorRuntimeState = {
            status: 'disconnected',
            reachable: false,
            message: connectError ?? 'adaptor is not connected',
          };
          lastKnown.set(id, state);
          return {
            id,
            name: adaptor.name,
            status: state.status,
            reachable: state.reachable,
            latencyMs: null,
            message: state.message,
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
          id,
          name: adaptor.name,
          status: 'connected',
          reachable: health.ok,
          latencyMs: health.latencyMs,
          ...(health.message === undefined ? {} : { message: health.message }),
        };
      } catch (error) {
        lastKnown.set(id, {
          status: 'error',
          reachable: false,
          message: error instanceof Error ? error.message : 'health check failed',
        });
        return {
          id,
          name: adaptor.name,
          status: 'error',
          reachable: false,
          latencyMs: null,
          message: error instanceof Error ? error.message : 'health check failed',
        };
      }
    }),
  );
}

/**
 * Connect every registered adaptor once, at boot, without blocking startup.
 *
 * Nothing called `connect()` before this except the webhook push path, so the
 * console could only ever say "not connected", and the first payment was what
 * finally established (or failed to establish) the link. Logging the outcome at
 * boot gives an operator one line to read in `docker compose logs api`.
 *
 * Never throws: an unreachable accounting system must not stop the API from
 * serving the console that reports on it.
 */
export async function connectConfiguredAdaptors(): Promise<void> {
  await Promise.all(
    adaptorRegistry.list().map(async (id) => {
      const adaptor = adaptorRegistry.get(id);
      try {
        await adaptor.connect();
        logger.info({ adaptor: id }, 'Adaptor connected on startup');
      } catch (err) {
        logger.warn(
          { adaptor: id, reason: err instanceof Error ? err.message : 'connect failed' },
          'Adaptor not connected on startup',
        );
      }
    }),
  );
}
