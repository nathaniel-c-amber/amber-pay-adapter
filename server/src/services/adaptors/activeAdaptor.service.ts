/* Which accounting system this deployment integrates with.
 *
 * AN ORGANIZATION INTEGRATES WITH EXACTLY ONE, and chooses it at setup. So a
 * deployment has an ACTIVE adaptor rather than a set of them, and every surface
 * that shows a connection must be restricted to it. Without that restriction a
 * QuickBooks-only organization is shown a suspended Sage route reading "Sage
 * credentials are not configured" — a fault that is not real, on the console's
 * most important page, and one an operator will try to fix.
 *
 * PRECEDENCE: the stored choice first (what the wizard wrote), then the
 * environment. The environment half is TRANSITIONAL, like the credential
 * fallback in `credentials.provider.ts`: a deployment configured entirely from
 * `.env` keeps working, and the default is 'quickbooks' because that is what the
 * webhook push path used to hardcode. Delete it once the wizard owns the choice.
 */

import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { settingsService } from '../settings/settings.service.js';
import { adaptorRegistry } from './registry.js';
import type { AdaptorId } from '../../types/adaptor.js';
import type { AdaptorRegistry } from './registry.js';
import type { ConfiguredAdaptorId } from '../../models/deploymentSettings.js';

/**
 * Just the one question this file needs answered, so a caller can pass the
 * settings service IT is using.
 *
 * Passing the instance rather than reaching for the module singleton matters
 * because the two can genuinely differ — any test, and any future caller holding
 * its own service, would otherwise have its WRITE go to one row while the active
 * accounting system was decided from another. That is the same hidden coupling
 * that makes the stored-credentials branch of `credentials.provider.ts` hard to
 * test, and the fix is the same: name the dependency.
 */
export type ConfiguredAdaptorReader = {
  configuredAdaptorId(): Promise<ConfiguredAdaptorId | null>;
};

/**
 * The accounting system this deployment should use.
 *
 * Falls back to the environment when the stored choice cannot be read — a
 * corrupt settings row must not take the accounting link offline when a usable
 * value is configured next to it.
 */
export async function resolveConfiguredAdaptorId(
  reader: ConfiguredAdaptorReader = settingsService,
): Promise<AdaptorId | null> {
  try {
    const stored = await reader.configuredAdaptorId();
    if (stored) {
      return stored;
    }
  } catch (err) {
    logger.warn({ err }, 'Stored adaptor choice unreadable; falling back to the environment');
  }
  return env.ADAPTOR_ID;
}

/**
 * Point the registry at the configured accounting system.
 *
 * Called at boot, and again whenever the choice changes. It also resets the
 * cached instance for the newly active adaptor: that instance holds the
 * credentials it connected with (and a rotated refresh token), so switching
 * systems — or correcting the credentials of the same one — would otherwise keep
 * reporting the previous failure.
 */
export async function syncConfiguredAdaptor(
  registry: AdaptorRegistry = adaptorRegistry,
  reader: ConfiguredAdaptorReader = settingsService,
): Promise<AdaptorId | null> {
  const id = await resolveConfiguredAdaptorId(reader);
  const previous = registry.activeAdaptorId();
  registry.setActiveAdaptorId(id);
  if (id && previous !== id) {
    registry.reset(id);
  }
  return id;
}
