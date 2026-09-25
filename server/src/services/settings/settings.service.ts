/* Deployment settings, and the one rule that governs them: a secret goes in and
 * never comes back out.
 *
 * WRITE-ONLY, NOT "HIDDEN IN THE UI". A `GET` returns whether a credential is
 * configured and its last four characters, and nothing else. There is no
 * endpoint, no method and no projection in this file that returns a stored
 * credential, so a console cannot display one, a browser devtools panel cannot
 * hold one, and a response logged by a reverse proxy cannot capture one.
 *
 * THE PLAINTEXT EXISTS IN EXACTLY ONE PLACE, `resolveCredentials()`, which is
 * explicitly server-side: the webhook controller needs the signature secret and
 * the adaptor needs its OAuth fields, and both are the server talking to itself.
 * It is named to be conspicuous at a call site, and it must never be serialized
 * into an HTTP response, an event detail, a failure note, or a log line.
 *
 * WHY VALIDATION LIVES HERE, not in the wizard: the wizard is one client. A
 * value that arrives from anywhere else — a script, a future API consumer, a
 * hand-run curl — must meet the same rules, so the rules sit at the one boundary
 * every write crosses.
 */

import { logger } from '../../utils/logger.js';
import { parseDurationMs } from '../../utils/duration.js';
import { AppError, ValidationError } from '../../utils/errors.js';
import { lastFourOf, openSecret, sealSecret, secretsConfigured } from '../../utils/secrets.js';
import { getRepositories } from '../../repositories/index.js';
import { env } from '../../config/env.js';
import type { SettingsRepository } from '../../types/repository.js';
import type {
  ConfiguredAdaptorId,
  DeploymentSettings,
  DeploymentSettingsPatch,
} from '../../models/deploymentSettings.js';

/**
 * What a read is allowed to say about a stored secret.
 *
 * `unreadable` exists because "no credential" and "a credential I cannot open"
 * are different facts that need different actions, and reporting the second as
 * the first would invite an operator to overwrite a credential that is very
 * likely still the correct one under a key this process was not given.
 */
export interface CredentialPresence {
  configured: boolean;
  /** Last four characters, or null when the value is too short to disclose any. */
  lastFour: string | null;
  unreadable: boolean;
}

export interface PublicGatewaySettings {
  clientId: string | null;
  webhookSecret: CredentialPresence;
}

export interface PublicAdaptorSettings {
  id: ConfiguredAdaptorId | null;
  realmId: string | null;
  baseUrl: string | null;
  credentials: CredentialPresence;
  /**
   * Can the provider-authorization step actually run?
   *
   * True when BOTH the client id and the client secret are stored. `credentials
   * .configured` answers "is there any stored credential at all", which is not the
   * question the setup screen has: it needs to know whether the two values the
   * authorization URL is built from are present, or it would offer a button that
   * fails with a 400 whose cause is invisible from the browser.
   *
   * It discloses PRESENCE of named fields and nothing about their values — the same
   * category of information as `lastFour`, and the reason the browser never has to
   * be told a secret to decide whether it can ask the server to start a flow.
   */
  canAuthorize: boolean;
}

export interface PublicDeploymentSettings {
  /**
   * The deployment's organization identity, read from `env.ORGANIZATION_ID`
   * rather than from the row. It is deliberately NOT stored: two copies of an
   * identity are two chances to disagree, and a mismatch here is exactly the
   * failure that makes rows invisible to the users they belong to.
   */
  organizationId: string;
  organizationName: string | null;
  gateway: PublicGatewaySettings;
  adaptor: PublicAdaptorSettings;
  syncInterval: string | null;
  alertTarget: string | null;
  verifiedAt: string | null;
  configuredAt: string | null;
  /** False while the onboarding wizard still has work to do. */
  configured: boolean;
  /** False when no encryption key is configured, so writes cannot be accepted. */
  writable: boolean;
}

/**
 * Plaintext credentials, for server-side use only.
 *
 * NOT part of any API contract. If this type ever appears in a response shape,
 * the write-only guarantee has been broken.
 */
export interface ResolvedCredentials {
  webhookSecret: string | null;
  adaptor:
    | {
        id: ConfiguredAdaptorId;
        realmId: string | null;
        baseUrl: string | null;
        fields: Record<string, string>;
      }
    | null;
}

/** Read a stored secret into a presence summary, never into a value. */
function presence(sealed: Buffer | null): CredentialPresence {
  if (!sealed) {
    return { configured: false, lastFour: null, unreadable: false };
  }
  try {
    return { configured: true, lastFour: lastFourOf(openSecret(sealed)), unreadable: false };
  } catch {
    return { configured: true, lastFour: null, unreadable: true };
  }
}

/** Are both application credentials present, so a grant can be started? */
function canAuthorize(sealed: Buffer | null): boolean {
  if (!sealed) return false;
  try {
    const fields = JSON.parse(openSecret(sealed)) as Record<string, unknown>;
    return (
      typeof fields['clientId'] === 'string' &&
      fields['clientId'].trim().length > 0 &&
      typeof fields['clientSecret'] === 'string' &&
      fields['clientSecret'].trim().length > 0
    );
  } catch {
    return false;
  }
}

function toPublic(
  settings: DeploymentSettings,
  organizationId: string,
  writable: boolean,
): PublicDeploymentSettings {
  return {
    organizationId,
    organizationName: settings.organizationName,
    gateway: {
      clientId: settings.gatewayClientId,
      webhookSecret: presence(settings.gatewayWebhookSecret),
    },
    adaptor: {
      id: settings.adaptorId,
      realmId: settings.adaptorRealmId,
      baseUrl: settings.adaptorBaseUrl,
      credentials: presence(settings.adaptorCredentials),
      canAuthorize: canAuthorize(settings.adaptorCredentials),
    },
    syncInterval: settings.syncInterval,
    alertTarget: settings.alertTarget,
    verifiedAt: settings.verifiedAt,
    configuredAt: settings.configuredAt,
    configured: settings.configuredAt !== null,
    writable,
  };
}

/**
 * A cadence, checked with the SAME parser the TTLs use.
 *
 * Absence is allowed (nothing configured yet). An unrecognised duration is
 * refused at the edge rather than stored and re-interpreted later — a stored
 * cadence that its consumer cannot parse is a silent default, and a silent
 * default on a sync schedule is a schedule nobody chose.
 */
function assertValidSyncInterval(value: string): void {
  try {
    parseDurationMs(value);
  } catch {
    throw new ValidationError('syncInterval must be a duration such as "30s", "5m" or "1h"');
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`);
  }
}

/**
 * Refuse a credential write this deployment cannot honour.
 *
 * WITHOUT THIS the first write fails inside `sealSecret` with a 500, which reads
 * as a bug in the API rather than as one missing environment variable — and the
 * operator's next move is to report it instead of generating a key. A missing
 * `SECRETS_KEY` is a deployment state, not an internal fault: the API is
 * deliberately allowed to boot without one (an upgrade must not take a working
 * install offline), so the refusal belongs at the write, where it is actionable.
 */
function assertStorable(): void {
  if (!secretsConfigured()) {
    throw new AppError(
      503,
      'SECRETS_NOT_CONFIGURED',
      'This deployment has no SECRETS_KEY, so credentials cannot be stored. Generate one with `openssl rand -hex 32` and set it in the environment.',
    );
  }
}

function assertHttpUrl(value: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${field} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationError(`${field} must be an http(s) URL`);
  }
}

export interface GatewayUpdate {
  clientId?: string | null;
  /** Plaintext in, sealed at rest. `null` clears it. */
  webhookSecret?: string | null;
}

export interface AdaptorUpdate {
  id?: ConfiguredAdaptorId | null;
  realmId?: string | null;
  baseUrl?: string | null;
  /**
   * MERGED into the stored set, not written over it. A `null` value clears that one
   * field; a blank or absent value leaves it alone. See `mergeCredentials`.
   */
  credentials?: Record<string, string | null> | null;
}

export interface PreferencesUpdate {
  organizationName?: string | null;
  syncInterval?: string | null;
  alertTarget?: string | null;
}

export class SettingsService {
  constructor(private readonly repository: SettingsRepository = getRepositories().settings) {}

  /** The write-only projection. No credential value appears in the result. */
  async getSettings(): Promise<PublicDeploymentSettings> {
    return toPublic(await this.repository.get(), env.ORGANIZATION_ID, secretsConfigured());
  }

  /**
   * The organization's display name, for callers that must not read the whole
   * settings row.
   *
   * It exists so `/auth/me` can name the organization to EVERY signed-in user.
   * `/settings` is gated on the `system` scope, but the name is on every page
   * header and in every invitation, so an operator without that scope would see a
   * blank organization where they should see the name. Returns null before setup
   * is finished, and the caller falls back to the id rather than showing nothing.
   */
  async getOrganizationName(): Promise<string | null> {
    return (await this.repository.get()).organizationName;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.repository.get()).configuredAt !== null;
  }

  /**
   * The chosen accounting system, whether or not its credentials are set yet.
   *
   * Separate from `resolveCredentials()`, which returns an adaptor only when the
   * credentials are present too. The CHOICE has to be readable on its own: the
   * console must be able to say "Sage is selected but not yet connected" rather
   * than fall back to guessing, and mid-wizard it is exactly the state the
   * operator is in.
   */
  async configuredAdaptorId(): Promise<ConfiguredAdaptorId | null> {
    return (await this.repository.get()).adaptorId;
  }

  async updateGateway(update: GatewayUpdate): Promise<PublicDeploymentSettings> {
    const patch: DeploymentSettingsPatch = {};
    const changed: string[] = [];

    if (update.clientId !== undefined) {
      if (update.clientId !== null) assertNonEmpty(update.clientId, 'gateway.clientId');
      patch.gatewayClientId = update.clientId;
      changed.push('gateway.clientId');
    }
    if (update.webhookSecret !== undefined) {
      if (update.webhookSecret !== null) assertStorable();
      patch.gatewayWebhookSecret =
        update.webhookSecret === null ? null : sealSecret(assertNonEmptySecret(update.webhookSecret, 'gateway.webhookSecret'));
      // The VALUE is never named in the audit line — only that it changed.
      changed.push('gateway.webhookSecret');
    }

    return this.apply(patch, changed);
  }

  async updateAdaptor(update: AdaptorUpdate): Promise<PublicDeploymentSettings> {
    const patch: DeploymentSettingsPatch = {};
    const changed: string[] = [];

    if (update.id !== undefined) {
      patch.adaptorId = update.id;
      changed.push('adaptor.id');
    }
    if (update.realmId !== undefined) {
      patch.adaptorRealmId = update.realmId;
      changed.push('adaptor.realmId');
    }
    if (update.baseUrl !== undefined) {
      if (update.baseUrl !== null) assertHttpUrl(update.baseUrl, 'adaptor.baseUrl');
      patch.adaptorBaseUrl = update.baseUrl;
      changed.push('adaptor.baseUrl');
    }
    if (update.credentials !== undefined) {
      if (update.credentials === null) {
        patch.adaptorCredentials = null;
      } else {
        assertStorable();
        const current = await this.repository.get();
        patch.adaptorCredentials = await mergeCredentials(
          current.adaptorCredentials,
          update.credentials,
        );
        /*
          Refuse to leave a credential set that is present but EMPTY. Doing so would
          report `configured: true` with nothing behind it — exactly the ambiguous
          state the presence model exists to prevent. Clearing the whole set is still
          possible, and is spelled `credentials: null`.
        */
        const remaining = Object.keys(
          JSON.parse(openSecret(patch.adaptorCredentials)) as Record<string, string>,
        );
        if (remaining.length === 0) {
          throw new ValidationError(
            'adaptor.credentials would be left empty; clear them explicitly instead',
          );
        }
      }
      changed.push('adaptor.credentials');
    }

    return this.apply(patch, changed);
  }

  async updatePreferences(update: PreferencesUpdate): Promise<PublicDeploymentSettings> {
    const patch: DeploymentSettingsPatch = {};
    const changed: string[] = [];

    if (update.organizationName !== undefined) {
      if (update.organizationName !== null) {
        assertNonEmpty(update.organizationName, 'organizationName');
      }
      patch.organizationName = update.organizationName;
      changed.push('organizationName');
    }
    if (update.syncInterval !== undefined) {
      if (update.syncInterval !== null) assertValidSyncInterval(update.syncInterval);
      patch.syncInterval = update.syncInterval;
      changed.push('syncInterval');
    }
    if (update.alertTarget !== undefined) {
      patch.alertTarget = update.alertTarget;
      changed.push('alertTarget');
    }

    return this.apply(patch, changed);
  }

  /** Record that the connection was proven to work. */
  async markVerified(at: string = new Date().toISOString()): Promise<PublicDeploymentSettings> {
    return this.apply({ verifiedAt: at }, ['verifiedAt']);
  }

  /**
   * Stamp the deployment as configured. IDEMPOTENT BY DESIGN.
   *
   * The first stamp is a fact about the deployment, and the console gates the
   * whole wizard on its presence — so a second call must NOT move it. A reloaded
   * wizard, a retried request or a double-clicked Finish button would otherwise
   * rewrite when this deployment was first set up, which is exactly the kind of
   * recorded fact an operator later reasons from.
   *
   * Reads before writing so the ordinary repeat is a no-op. Two CONCURRENT first
   * calls could still both write, since the repository's `update` is
   * unconditional; the consequence is a timestamp differing by milliseconds,
   * which does not justify a conditional-UPDATE method the way the tour's
   * per-user stamp did (there the answer "did THIS call write?" drove the UI).
   */
  async complete(now: string = new Date().toISOString()): Promise<PublicDeploymentSettings> {
    const current = await this.repository.get();
    if (current.configuredAt !== null) {
      return toPublic(current, env.ORGANIZATION_ID, secretsConfigured());
    }
    return this.apply({ configuredAt: now }, ['configuredAt']);
  }

  /**
   * Forget that the connection was ever verified.
   *
   * Called when a credential changes, rather than asking every caller to
   * remember: a caller that forgets leaves the console showing "verified" for a
   * credential that has since been replaced — a stale tick on the one page whose
   * job is to say whether the connection works.
   */
  async clearVerification(): Promise<void> {
    await this.repository.update({ verifiedAt: null });
  }

  /**
   * Replace the stored adaptor credentials WITHOUT invalidating the verification.
   *
   * Used only for an upstream ROTATION. The exchange that produced these values
   * is the same one that just proved the connection works, so clearing
   * `verifiedAt` — which `updateAdaptor` does, correctly, for an operator's edit
   * — would make a healthy connection look like one nobody has tested.
   */
  async storeRotatedCredentials(fields: Record<string, string>): Promise<void> {
    await this.repository.update({ adaptorCredentials: sealSecret(JSON.stringify(fields)) });
    logger.info(
      { organizationId: env.ORGANIZATION_ID, fields: ['adaptor.credentials(rotated)'] },
      'Deployment settings updated',
    );
  }

  /**
   * Plaintext credentials, for the server's own use.
   *
   * SERVER-SIDE ONLY. The webhook controller verifies against `webhookSecret`;
   * the adaptor connects with `adaptor.fields`. Nothing that returns from here
   * may be serialized into a response, an event detail, a failure note or a log.
   */
  async resolveCredentials(): Promise<ResolvedCredentials> {
    const settings = await this.repository.get();
    return {
      webhookSecret: settings.gatewayWebhookSecret
        ? openSecret(settings.gatewayWebhookSecret)
        : null,
      adaptor:
        settings.adaptorId && settings.adaptorCredentials
          ? {
              id: settings.adaptorId,
              realmId: settings.adaptorRealmId,
              baseUrl: settings.adaptorBaseUrl,
              fields: JSON.parse(openSecret(settings.adaptorCredentials)) as Record<string, string>,
            }
          : null,
    };
  }

  private async apply(
    patch: DeploymentSettingsPatch,
    changed: string[],
  ): Promise<PublicDeploymentSettings> {
    // A credential change makes the previous verification a claim about a value
    // that no longer exists, so it is dropped in the same write.
    if (
      patch.gatewayWebhookSecret !== undefined ||
      patch.adaptorCredentials !== undefined ||
      patch.adaptorRealmId !== undefined ||
      patch.adaptorBaseUrl !== undefined ||
      patch.adaptorId !== undefined
    ) {
      patch.verifiedAt = null;
      changed.push('verifiedAt(cleared)');
    }

    const settings = await this.repository.update(patch);
    if (changed.length > 0) {
      /*
        Field NAMES only. This is an audit trail for "who changed what, when",
        and a trail that records the value it is protecting is not an audit
        trail — it is a second copy of the secret with weaker protection.
      */
      logger.info(
        { organizationId: env.ORGANIZATION_ID, fields: changed },
        'Deployment settings updated',
      );
    }
    return toPublic(settings, env.ORGANIZATION_ID, secretsConfigured());
  }
}

function assertNonEmptySecret(value: string, field: string): string {
  assertNonEmpty(value, field);
  return value;
}

/**
 * Reject a credential set that is present but empty.
 *
 * `{ clientId: '' }` would seal to a stored object that reads as "configured"
 * while carrying nothing, which is worse than no credential: the console reports
 * a connection that was never actually given anything to connect with.
 */
/**
 * Merge an incoming credential map into what is already stored.
 *
 * WHY THIS EXISTS — a silent data-loss bug. The credential blob was written as a
 * whole-value replace, while every form in the console sends only the fields the
 * operator actually filled in (the rest are blank, because a stored secret is
 * write-only and cannot be pre-filled). So saving ONE field deleted the others: a
 * form that asked for six values and had three already stored would, on re-entry,
 * destroy the client id the operator could not see and therefore could not retype.
 * The write "succeeded" and the connection broke afterwards, which is the worst
 * shape a bug can take.
 *
 * THE RULE, which is the SAME one `withoutUndefined` already applies to every
 * other column (see `models/deploymentSettings.ts`):
 *   - a key present with a NON-EMPTY value replaces that one field;
 *   - a key present with `null` clears that one field;
 *   - a key absent, or present with an empty string, leaves that field alone.
 *
 * An empty string therefore means "the operator did not fill this in", never
 * "erase this". Erasing is possible but must be said explicitly, which is what
 * `null` is for.
 */
async function mergeCredentials(
  stored: Buffer | null,
  incoming: Record<string, string | null>,
): Promise<Buffer> {
  let existing: Record<string, string> = {};
  if (stored) {
    try {
      existing = JSON.parse(openSecret(stored)) as Record<string, string>;
    } catch {
      /*
        An unreadable or corrupt stored blob is treated as empty rather than fatal.
        The merge is an operator saving a correction, and refusing to let them store a
        new value because the old one is undecryptable would be a worse failure than
        starting the set over. The unreadable state is still reported by the settings
        read, which is where an operator can see it.
      */
      existing = {};
    }
  }

  const merged: Record<string, string> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    const trimmed = value.trim();
    // Blank means "not filled in", so the stored value survives.
    if (trimmed.length > 0) {
      merged[key] = trimmed;
    }
  }

  return sealSecret(JSON.stringify(merged));
}

/** Shared service instance, backed by the process repository container. */
export const settingsService = new SettingsService();
