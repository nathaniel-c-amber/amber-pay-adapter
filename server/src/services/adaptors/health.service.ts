import { adaptorRegistry } from './registry.js';
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
 * Probe every registered adaptor. `healthCheck` reports rather than throws, so
 * one unreachable adaptor cannot fail the whole status response.
 */
export async function probeAdaptors(): Promise<ServiceStatusAdaptors[]> {
  const ids = adaptorRegistry.list();
  return Promise.all(
    ids.map(async (id): Promise<ServiceStatusAdaptors> => {
      const adaptor: AccountingAdaptor = adaptorRegistry.get(id);
      try {
        const [status, health] = await Promise.all([adaptor.status(), adaptor.healthCheck()]);
        return {
          id,
          name: adaptor.name,
          status,
          reachable: health.ok,
          latencyMs: health.latencyMs,
          ...(health.message === undefined ? {} : { message: health.message }),
        };
      } catch (error) {
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
