import { AdaptorRegistry, adaptorRegistry } from './registry.js';
import { QuickBooksAdaptor } from './quickbooks.js';
import { SageAdaptor } from './sage.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { AdaptorId } from './types.js';

describe('AdaptorRegistry', () => {
  it('registers and lists adaptors', () => {
    const registry = new AdaptorRegistry();
    registry.register('quickbooks', () => new QuickBooksAdaptor());
    registry.register('sage', () => new SageAdaptor());
    expect(registry.list()).toEqual(['quickbooks', 'sage']);
  });

  it('get returns a cached instance', () => {
    const registry = new AdaptorRegistry();
    registry.register('quickbooks', () => new QuickBooksAdaptor());
    const a = registry.get('quickbooks');
    const b = registry.get('quickbooks');
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(QuickBooksAdaptor);
  });

  it('createAdaptor returns a fresh instance', () => {
    const registry = new AdaptorRegistry();
    registry.register('quickbooks', () => new QuickBooksAdaptor());
    const a = registry.createAdaptor('quickbooks');
    const b = registry.createAdaptor('quickbooks');
    expect(a).not.toBe(b);
  });

  it('throws NotFoundError for an unknown id', () => {
    const registry = new AdaptorRegistry();
    expect(() => registry.get('unknown' as AdaptorId)).toThrow(NotFoundError);
    expect(() => registry.createAdaptor('unknown' as AdaptorId)).toThrow(NotFoundError);
  });

  it('throws ConflictError on duplicate registration', () => {
    const registry = new AdaptorRegistry();
    registry.register('quickbooks', () => new QuickBooksAdaptor());
    expect(() => registry.register('quickbooks', () => new QuickBooksAdaptor())).toThrow(
      ConflictError,
    );
  });

  it('throws ConflictError when the factory id does not match the registered id', () => {
    const registry = new AdaptorRegistry();
    expect(() => registry.register('quickbooks', () => new SageAdaptor())).toThrow(ConflictError);
  });

  it('singleton is pre-registered with quickbooks and sage', () => {
    expect(adaptorRegistry.list()).toEqual(['quickbooks', 'sage']);
    expect(adaptorRegistry.get('quickbooks')).toBeInstanceOf(QuickBooksAdaptor);
    expect(adaptorRegistry.get('sage')).toBeInstanceOf(SageAdaptor);
  });
});
