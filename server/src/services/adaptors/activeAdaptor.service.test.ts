import { AdaptorRegistry } from './registry.js';
import { QuickBooksAdaptor } from './quickbooks.service.js';
import { SageAdaptor } from './sage.service.js';
import { syncConfiguredAdaptor } from './activeAdaptor.service.js';
import { env } from '../../config/env.js';

/**
 * An organization integrates with exactly ONE accounting system.
 *
 * The defect being pinned: a QuickBooks-only deployment's Connections page drew
 * a second, suspended route for Sage reading "Sage credentials are not
 * configured". Nothing was broken — the route simply should not have been there.
 * The distinction that was missing is between "which adaptors exist" (the
 * catalogue the wizard offers) and "which one this deployment USES".
 */

describe('AdaptorRegistry: which accounting system this deployment uses', () => {
  it('treats a registry that was never activated as unrestricted', () => {
    const registry = new AdaptorRegistry();
    registry.register('quickbooks', () => new QuickBooksAdaptor());
    registry.register('sage', () => new SageAdaptor());

    // "Which exist" is always the full catalogue — the wizard offers it as a choice…
    expect(registry.list()).toEqual(['quickbooks', 'sage']);
    // …while an unactivated registry answers exactly as it did before this
    // concept existed, so boot is the one place that restricts it.
    expect(registry.activeAdaptorId()).toBeNull();
    expect(registry.isActive('quickbooks')).toBe(true);
    expect(registry.isActive('sage')).toBe(true);
  });

  it('excludes every other system once one has been chosen', () => {
    const registry = new AdaptorRegistry();
    registry.register('quickbooks', () => new QuickBooksAdaptor());
    registry.register('sage', () => new SageAdaptor());

    registry.setActiveAdaptorId('quickbooks');

    // The catalogue is unchanged: the choice narrows what is USED, not what exists.
    expect(registry.list()).toEqual(['quickbooks', 'sage']);
    expect(registry.activeAdaptorId()).toBe('quickbooks');
    expect(registry.isActive('quickbooks')).toBe(true);
    expect(registry.isActive('sage')).toBe(false);
  });
});

describe('syncConfiguredAdaptor', () => {
  it('restricts the registry to the configured system, discarding the cached connection', async () => {
    const registry = new AdaptorRegistry();
    registry.register('quickbooks', () => new QuickBooksAdaptor());
    registry.register('sage', () => new SageAdaptor());
    // A connection established before the choice was known. It holds the
    // credentials it connected with and (for QuickBooks) a rotated refresh token,
    // so it must not outlive the choice.
    const stale = registry.get('quickbooks');

    const id = await syncConfiguredAdaptor(registry);

    expect(id).toBe(env.ADAPTOR_ID);
    expect(registry.isActive('quickbooks')).toBe(true);
    expect(registry.isActive('sage')).toBe(false);
    expect(registry.get('quickbooks')).not.toBe(stale);
  });
});
