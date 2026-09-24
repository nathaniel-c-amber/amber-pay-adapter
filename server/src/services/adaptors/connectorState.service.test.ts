import { withAdaptorConnections } from './connectorState.service.js';
import { env } from '../../config/env.js';
import type { AdaptorRuntimeState } from './health.service.js';
import type { ConnectorState } from '../../models/domain.js';

function row(overrides: Partial<ConnectorState> = {}): ConnectorState {
  return {
    id: 'quickbooks',
    organizationId: 'org-1',
    label: 'QuickBooks Online',
    terminus: 'quickbooks',
    status: 'open',
    reading: 'Operational',
    note: 'Awaiting adaptor state',
    ...overrides,
  };
}

const connected: AdaptorRuntimeState = { status: 'connected', reachable: true, latencyMs: 93 };
const unauthorized: AdaptorRuntimeState = {
  status: 'disconnected',
  reachable: false,
  message: 'QuickBooks is configured but not authorized: set QUICKBOOKS_ACCESS_TOKEN',
};

/** Both registered adaptors are stubbed: quickbooks as given, sage disconnected. */
const readerFor =
  (state: AdaptorRuntimeState) =>
  async (id: string): Promise<AdaptorRuntimeState> => {
    if (id !== 'quickbooks') return { status: 'disconnected', reachable: false };
    return state;
  };

/** Apply the merge and find the row for one connector id. */
async function merged(
  state: AdaptorRuntimeState,
  stored: ConnectorState[] = [row()],
): Promise<ConnectorState[]> {
  return withAdaptorConnections(stored, ['org-1'], readerFor(state));
}

function find(rows: ConnectorState[], id: string): ConnectorState {
  return rows.find((r) => r.id === id) as ConnectorState;
}

describe('withAdaptorConnections', () => {
  /*
    REGRESSION: a derived row used to fall back to the literal '*' when the caller
    held a wildcard. '*' is a POLICY wildcard, and stored as a row value it makes
    a connection that no policy can name and no filter can match — visible to the
    one account that bypasses filtering, and to nobody else.
  */
  it('files a derived row under the deployment organization, never the policy wildcard', async () => {
    const rows = await withAdaptorConnections([], null, readerFor(connected));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === env.ORGANIZATION_ID)).toBe(true);
    expect(rows.some((r) => r.organizationId === '*')).toBe(false);
  });

  it('leaves a stored row alone when the adaptor is connected and reachable', async () => {
    const rows = await merged(connected);
    const quickbooks = find(rows, 'quickbooks');
    expect(quickbooks.status).toBe('open');
    expect(quickbooks.reading).toBe('Operational');
    expect(quickbooks.note).toBe('Adaptor connected · 93 ms round trip');
  });

  it('suspends the stored row and carries the reason when the adaptor cannot connect', async () => {
    const quickbooks = find(await merged(unauthorized), 'quickbooks');
    expect(quickbooks.status).toBe('suspended');
    expect(quickbooks.reading).toBe('No connection');
    // The actionable message reaches the operator, not a bare "unreachable".
    expect(quickbooks.note).toContain('QUICKBOOKS_ACCESS_TOKEN');
  });

  it('suspends a connected adaptor whose health probe is failing', async () => {
    const quickbooks = find(
      await merged({ status: 'connected', reachable: false, message: 'QuickBooks answered 401' }),
      'quickbooks',
    );
    expect(quickbooks.status).toBe('suspended');
    expect(quickbooks.note).toBe('QuickBooks answered 401');
  });

  it('leaves rows with no registered adaptor untouched', async () => {
    const gateway = row({ id: 'amber-pay', label: 'Amber Pay Gateway', terminus: 'amber-pay' });
    const rows = await merged(unauthorized, [gateway]);
    expect(find(rows, 'amber-pay')).toEqual(gateway);
  });

  /*
    The live deployment stored NO connector rows at all, so the Connections page
    listed nothing however the accounting link was doing. A row per registered
    adaptor is derived from the adaptor itself.
  */
  it('derives a row per registered adaptor when none are stored', async () => {
    const rows = await merged(unauthorized, []);
    const quickbooks = find(rows, 'quickbooks');
    expect(quickbooks).toMatchObject({
      label: 'QuickBooks Online',
      terminus: 'quickbooks',
      status: 'suspended',
      reading: 'No connection',
      organizationId: 'org-1',
    });
    expect(quickbooks.note).toContain('QUICKBOOKS_ACCESS_TOKEN');
    // Both adaptors are registered, so both appear.
    expect(rows.map((r) => r.id).sort()).toEqual(['quickbooks', 'sage']);
  });

  it('reports a derived row as connected when the adaptor is', async () => {
    const quickbooks = find(await merged(connected, []), 'quickbooks');
    expect(quickbooks.status).toBe('open');
    expect(quickbooks.reading).toBe('Connected');
    expect(quickbooks.note).toContain('93 ms');
  });

  it('does not duplicate an adaptor that already has a stored row', async () => {
    const rows = await merged(connected, [row()]);
    expect(rows.filter((r) => r.id === 'quickbooks')).toHaveLength(1);
    expect(rows.map((r) => r.id)).toEqual(['quickbooks', 'sage']);
  });
});
