import { adaptorRegistry } from './registry.js';
import { lastKnownAdaptorStates } from './health.service.js';
import type { AdaptorRuntimeState } from './health.service.js';
import type { AdaptorId } from '../../types/adaptor.js';
import type { ConnectorState, ConnectorTerminus } from '../../models/domain.js';

/**
 * The accounting connections, with the adaptors' real state on them.
 *
 * TWO PROBLEMS, VISIBLE AS ONE ABSENCE.
 *
 * 1. THE TWO PANES DISAGREED. The Overview's service window reads
 *    `/service/status`, which probes the adaptors, so it correctly said
 *    "QuickBooks is configured but not authorized". The Connections page reads
 *    the connector rows from this same dashboard payload — *stored* rows, seeded
 *    once and never touched by an adaptor — so the same moment could show
 *    "QuickBooks Online · Operational" and draw that route as healthy. A console
 *    whose two panes disagree about whether a route works cannot be trusted
 *    about anything else.
 *
 * 2. THE ROWS DID NOT EXIST. `connector_states` is seeded only in the in-memory
 *    repository; a Postgres deployment installs the table empty and nothing ever
 *    writes to it. So a real console's Connections page listed NOTHING, however
 *    healthy or broken the accounting link was — the page the product exists to
 *    show was blank while the panel beside it held the answer.
 *
 * The rows are therefore derived from the registered adaptors and merged with
 * any stored ones: a stored row for an adaptor's terminus gets the live state
 * overlaid, and an adaptor with no stored row gets one built from what it
 * actually reports.
 *
 * WHY THE OVERLAY LIVES HERE, NOT IN A COMPONENT: every consumer of these rows
 * (Connections, connection detail, Synchronization's push/pull cards, the
 * findings' affected connection, the service map) inherits the correction, and
 * no page can forget to apply it. One fact, one place.
 *
 * WHY IT DOES NOT PROBE: this runs on every dashboard poll, and a probe is a
 * network round trip to the accounting platform. It reads the last observed
 * state instead (populated by `/service/status`, which the console polls on the
 * same cadence), falling back to the adaptor's in-memory connection flag when
 * nothing has probed it yet.
 *
 * DIRECTION OF THE CLAIM: reachability can only DOWNGRADE. A connected and
 * reachable adaptor leaves a stored row's operational status alone — the path may
 * be degraded for its own reasons — while an unreachable one suspends it, because
 * a path whose accounting system cannot be reached is carrying nothing, whatever
 * the row was seeded with.
 */

/**
 * Which connector rows belong to a registered adaptor.
 *
 * The terminus vocabulary was authored to be the adaptor ids, so this mapping is
 * identity — kept explicit anyway, because an adaptor whose terminus is named
 * differently must fail to match (and get its own row) rather than silently
 * overlay the wrong path.
 */
const ADAPTOR_BY_TERMINUS: Partial<Record<ConnectorTerminus, AdaptorId>> = {
  quickbooks: 'quickbooks',
  sage: 'sage',
};

export type AdaptorStateReader = (id: AdaptorId) => Promise<AdaptorRuntimeState>;

/**
 * Default reader: the last probed state, or the adaptor's own connection flag
 * when nothing has probed it yet (a fresh process, before the first
 * `/service/status`). `reachable` follows the flag in that case: a connected
 * adaptor that has not been probed is not known to be broken.
 */
const readAdaptorState: AdaptorStateReader = async (id) => {
  const probed = lastKnownAdaptorStates().get(id);
  if (probed) return probed;
  const status = await adaptorRegistry.get(id).status();
  return { status, reachable: status === 'connected' };
};

/** The reading a suspended row carries: it is not moving anything. */
const NO_CONNECTION = 'No connection';

function isHealthy(state: AdaptorRuntimeState): boolean {
  return state.status === 'connected' && state.reachable;
}

function connectedNote(state: AdaptorRuntimeState): string {
  return state.latencyMs === undefined || state.latencyMs === null
    ? 'Adaptor connected'
    : `Adaptor connected · ${state.latencyMs} ms round trip`;
}

/**
 * Merge the adaptors' live state into the connector rows.
 *
 * `organizationIds` is the caller's authorized scope, used only for rows that
 * have to be created: a derived row belongs to the scope that can see it, and
 * `'*'` stands for a wildcard policy. The console strips this field before
 * rendering, so it exists to keep the payload honest, not to drive a screen.
 */
export async function withAdaptorConnections(
  stored: ConnectorState[],
  organizationIds: string[] | null,
  read: AdaptorStateReader = readAdaptorState,
): Promise<ConnectorState[]> {
  const registered = adaptorRegistry.list();
  const covered = new Set(
    stored.map((row) => ADAPTOR_BY_TERMINUS[row.terminus]).filter(Boolean) as AdaptorId[],
  );

  const merged = await Promise.all(
    stored.map(async (row): Promise<ConnectorState> => {
      const adaptorId = ADAPTOR_BY_TERMINUS[row.terminus];
      if (!adaptorId || !registered.includes(adaptorId)) return row;

      const state = await read(adaptorId);
      if (isHealthy(state)) {
        return { ...row, note: connectedNote(state) };
      }
      return {
        ...row,
        status: 'suspended',
        reading: NO_CONNECTION,
        note: state.message ?? 'Adaptor is not connected',
      };
    }),
  );

  const derived = await Promise.all(
    registered
      .filter((id) => !covered.has(id))
      .map(async (id): Promise<ConnectorState> => {
        const adaptor = adaptorRegistry.get(id);
        const state = await read(id);
        const healthy = isHealthy(state);
        return {
          id,
          organizationId: organizationIds?.[0] ?? '*',
          label: adaptor.name,
          terminus: id as ConnectorTerminus,
          status: healthy ? 'open' : 'suspended',
          reading: healthy ? 'Connected' : NO_CONNECTION,
          note: healthy ? connectedNote(state) : (state.message ?? 'Adaptor is not connected'),
        };
      }),
  );

  return [...merged, ...derived];
}
