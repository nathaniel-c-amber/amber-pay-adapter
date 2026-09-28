import { ConflictError, NotFoundError } from '../../utils/errors.js';
import type { AccountingAdaptor, AdaptorId } from '../../types/adaptor.js';
import { QuickBooksAdaptor } from './quickbooks.service.js';
import { SageAdaptor } from './sage.service.js';
import { rotationSink } from './credentials.provider.js';

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

  /**
   * The accounting system this deployment integrates with, or null when it has
   * not been restricted yet.
   *
   * "Which adaptors exist" and "which adaptor this deployment USES" are two
   * different questions, and conflating them is what put a suspended Sage row on
   * a QuickBooks-only console. `list()` answers the first — the catalogue the
   * onboarding wizard offers as a choice. `isActive()` answers the second, and
   * everything that probes, displays or pushes to a CONNECTION filters on it.
   *
   * Null means UNRESTRICTED rather than "none": a registry that was never
   * activated behaves exactly as it did before, so no test needs to activate one,
   * and boot activates explicitly. An organization integrates with exactly one
   * system, so production is always restricted.
   */
  private activeId: AdaptorId | null = null;

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

  /**
   * Forget the cached instance for an adaptor.
   *
   * MUST be called whenever configured credentials change. `get()` caches ONE
   * instance per adaptor id, and that instance remembers both the credentials it
   * was connected with and (for QuickBooks) a rotated refresh token — so without
   * a reset, saving new credentials leaves the console reporting the OLD failure,
   * and the operator sees their correction have no effect and re-enters it.
   */
  reset(id: AdaptorId): void {
    this.instances.delete(id);
  }

  /**
   * Restrict this deployment to one accounting system. `null` lifts the
   * restriction.
   *
   * MUST also be followed by `reset(id)` when the CHOICE changes, or the newly
   * chosen adaptor's cached instance (and its credentials) survives a switch.
   */
  setActiveAdaptorId(id: AdaptorId | null): void {
    this.activeId = id;
  }

  activeAdaptorId(): AdaptorId | null {
    return this.activeId;
  }

  /** May this deployment probe, display or push to this adaptor? */
  isActive(id: AdaptorId): boolean {
    return this.activeId === null || this.activeId === id;
  }
}

/** Singleton pre-registered with QuickBooks and Sage. */
export const adaptorRegistry = new AdaptorRegistry();
/*
  THE ROTATION SINK IS WIRED HERE, at the factory, because the only place that
  knows both "which adaptor" and "how to persist configuration" is this file's
  neighbourhood. An adaptor that mints a credential outside an explicit
  `connect()` — QuickBooks re-mints on a 401 so a long-running process survives
  an expired access token — has to tell someone, because Intuit spends the token
  it just issued. A deployment that persisted rotations only at boot works right
  up to its next restart and then cannot connect, which reads as an expired
  credential and is not one.

  `verify.service.ts` builds its adaptor through `createAdaptor()` for the same
  registry, so a verification can rotate too; it does not write, and that is
  deliberate — proving a credential works must not change stored state.
*/
adaptorRegistry.register(
  'quickbooks',
  () => new QuickBooksAdaptor(undefined, rotationSink('quickbooks')),
);
adaptorRegistry.register('sage', () => new SageAdaptor());
