import { ConflictError, NotFoundError } from '../../utils/errors.js';
import type { AccountingAdaptor, AdaptorId } from '../../types/adaptor.js';
import { QuickBooksAdaptor } from './quickbooks.service.js';
import { SageAdaptor } from './sage.service.js';

export type AdaptorFactory = () => AccountingAdaptor;

/**
 * Registry of accounting adaptors. Adaptors are registered by id via a
 * factory; `get` returns a cached instance, `createAdaptor` returns a fresh
 * one. Extensible: register new adaptors without touching existing code.
 *
 * TENANT NOTE: `get()` is single-tenant — it caches ONE instance per adaptor
 * id globally. For organization-scoped connections, use `createAdaptor()` to
 * build a fresh instance per tenant.
 */
export class AdaptorRegistry {
  private readonly factories = new Map<AdaptorId, AdaptorFactory>();
  private readonly instances = new Map<AdaptorId, AccountingAdaptor>();

  register(id: AdaptorId, factory: AdaptorFactory): void {
    if (this.factories.has(id)) {
      throw new ConflictError(`Adaptor already registered: ${id}`);
    }
    const adaptor = factory();
    if (adaptor.id !== id) {
      throw new ConflictError(`Adaptor factory for '${id}' produced id '${adaptor.id}'`);
    }
    this.factories.set(id, factory);
  }

  list(): AdaptorId[] {
    return [...this.factories.keys()];
  }

  createAdaptor(id: AdaptorId): AccountingAdaptor {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new NotFoundError(`Unknown adaptor: ${id}`);
    }
    return factory();
  }

  get(id: AdaptorId): AccountingAdaptor {
    const existing = this.instances.get(id);
    if (existing) {
      return existing;
    }
    const adaptor = this.createAdaptor(id);
    this.instances.set(id, adaptor);
    return adaptor;
  }
}

/** Singleton pre-registered with QuickBooks and Sage. */
export const adaptorRegistry = new AdaptorRegistry();
adaptorRegistry.register('quickbooks', () => new QuickBooksAdaptor());
adaptorRegistry.register('sage', () => new SageAdaptor());
