/* Deployment settings, and the one rule that governs them: a secret goes in and
 * never comes back out.
 *
 * WRITE-ONLY, NOT "HIDDEN IN THE UI". A `GET` returns whether a credential is
 * configured and its last four characters, and nothing else. There is no
 * endpoint, no method and no projection in this file that returns a stored
 * credential, so a console cannot display one, a browser devtools panel cannot
 * hold one, and a response logged by a reverse proxy cannot capture one.
 *
 * THE PLAINTEXT EXISTS IN EXACTLY TWO PLACES, both explicitly server-side.
 * `resolveCredentials()` is the general one: the webhook controller needs the
 * signature secret and the adaptor needs its OAuth fields. `resolveAppCredentials()`
 * is the narrow one — the client id/secret pair the browser-authorization flow is
 * handed, so the exchange cannot be built from a different pair than the one the
 * console decided it could authorize. Both are named to be conspicuous at a call
 * site, and neither must ever be serialized into an HTTP response, an event
 * detail, a failure note, or a log line.
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
  AdaptorId,
  CustomerMatchConfig,
  CustomerMatchMode,
  CustomerMatchStrategy,
} from '../../types/adaptor.js';
import { CUSTOM_FIELD_NAME } from '../adaptors/quickbooksWire.js';
import {
  environmentAdaptorCredentials,
  resolveAppCredentials,
} from '../adaptors/appCredentials.js';
import type { AppCredentialEnv } from '../adaptors/appCredentials.js';
import type {
  ConfiguredAdaptorId,
  DeploymentSettings,
  DeploymentSettingsPatch,
  InvoiceMatchingSettings,
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
   * Can the provider-authorization step actually run TO COMPLETION?
   *
   * True when the two values the authorization URL is built from resolve — stored
   * first, environment second, through the same `resolveAppCredentials` rule the
   * exchange itself uses — AND the deployment can keep what comes back. The
   * second half is `writable`: on a deployment with no `SECRETS_KEY` the provider
   * would accept the code, and the refresh token it returned would then be
   * refused by `assertStorable()` and thrown away. Offering the button there would
   * end with the operator told QuickBooks rejected an authorization it had in
   * fact accepted — indistinguishable, from the browser, from a real rejection.
   *
   * `credentials.configured` answers "is there any stored credential at all",
   * which is not the question the setup screen has: it needs to know whether the
   * flow can run, or it would offer a button that fails for a reason invisible
   * from where the click happened.
   *
   * It discloses PRESENCE of named fields and nothing about their values — the
   * same category of information as `lastFour`, and the reason the browser never
   * has to be told a secret to decide whether it can ask the server to start a
   * flow.
   */
  canAuthorize: boolean;
  /**
   * The customer matching rule, and whether it is complete enough to run.
   *
   * `fieldName` is echoed because the operator typed it and needs to see what
   * was saved. `ready` is the field the pipeline actually gates on, and it is
   * stricter than "a strategy is set": the `customField` strategy is
   * unusable without the field it names, and a console that showed a rule as
   * configured while the pipeline refused every payment would be worse than
   * showing nothing.
   */
  invoiceMatching: {
    strategy: CustomerMatchStrategy | null;
    mode: CustomerMatchMode | null;
    fieldName: string | null;
    depositAccountId: string | null;
    ready: boolean;
  };
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

/**
 * The application credentials the browser-authorization exchange is built from.
 *
 * Same warning as `ResolvedCredentials`: server-side only, and for a shorter
 * journey — out of a service method, into a redirect URL, and gone. The client
 * secret in particular must never reach a response body or a log line.
 */
export interface ResolvedAppCredentials {
  clientId: string;
  clientSecret: string;
  /** Where the exchange is sent; `null` lets the caller apply its own default. */
  baseUrl: string | null;
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

/**
 * The stored credential set as a plain record, or `null` when there is nothing
 * readable to take.
 *
 * `null` rather than a throw, because an undecryptable blob is a state an
 * operator has to be able to READ PAST: the stored side is simply treated as
 * absent and the environment decides. Refusing to describe the deployment at all
 * would take the whole settings read down for one bad row, and would disable a
 * button that would have worked.
 */
function storedFields(sealed: Buffer | null): Record<string, unknown> | null {
  if (!sealed) return null;
  try {
    const parsed: unknown = JSON.parse(openSecret(sealed));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Can the provider-authorization step run, for this adaptor, with what we have?
 *
 * STORED FIRST, ENVIRONMENT SECOND, through the one shared rule
 * (`resolveAppCredentials`) rather than a private reading of the sealed blob. That
 * is the whole point: a button the console offers and the pair the exchange is
 * built from are computed by the same function, so they cannot drift into
 * disagreeing — which is exactly the bug this replaced, where an env-configured
 * deployment was told its credentials were missing.
 *
 * `sealed` is the stored set ONLY IF the caller has established it belongs to
 * `id` (see `toPublic`). A set that belongs to the other accounting system is
 * never offered here: authorizing QuickBooks with Sage's client id produces an
 * authorization request the provider refuses, for a reason the browser cannot see.
 */
function canAuthorize(id: AdaptorId, sealed: Buffer | null, environment: AppCredentialEnv): boolean {
  return resolveAppCredentials(id, storedFields(sealed), environment) !== null;
}

function toPublic(
  settings: DeploymentSettings,
  organizationId: string,
  writable: boolean,
  environment: AppCredentialEnv,
): PublicDeploymentSettings {
  /*
    THE ACTIVE ADAPTOR, by the SAME precedence as
    `resolveConfiguredAdaptorId` (`activeAdaptor.service.ts`): the wizard's stored
    choice first, then the environment. Asking this file for its own opinion is
    how a console ends up describing a Sage deployment as QuickBooks.

    The stored blob is handed to `canAuthorize` only when the row says which
    adaptor it belongs to — the same gate `resolveCredentials()` applies, so a
    credential set stored beside no choice (or beside the other system) is ignored
    here exactly as the adaptor ignores it when connecting.
  */
  const activeId: AdaptorId = settings.adaptorId ?? env.ADAPTOR_ID;
  const stored = settings.adaptorId === activeId ? settings.adaptorCredentials : null;

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
      /*
        AND WRITABLE, because the flag means "this flow can run to completion"
        rather than "the two values the URL is built from are present". Without a
        `SECRETS_KEY` the provider accepts the authorization code, the returned
        refresh token is then refused by `assertStorable()` and discarded, and the
        operator is told the provider rejected an authorization it had in fact
        accepted. Offering a button whose outcome the server cannot keep is worse
        than not offering it.
      */
      canAuthorize: canAuthorize(activeId, stored, environment) && writable,
      invoiceMatching: {
        strategy: settings.invoiceMatchStrategy,
        mode: settings.invoiceMatchMode,
        fieldName: settings.invoiceMatchField,
        depositAccountId: settings.paymentDepositAccountId,
        ready: isMatchRuleReady(matchRuleOf(settings)),
      },
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

const MATCH_STRATEGIES: readonly CustomerMatchStrategy[] = ['displayName', 'customField', 'notes'];
const MATCH_MODES: readonly CustomerMatchMode[] = ['exact', 'contains'];

/** A partial matching rule as a write carries it. */
export interface InvoiceMatchingUpdate {
  strategy?: CustomerMatchStrategy | null;
  mode?: CustomerMatchMode | null;
  fieldName?: string | null;
  depositAccountId?: string | null;
}

/**
 * Validate one half of the matching rule.
 *
 * THE FIELD NAME IS CHECKED HERE, at the write, even though the pipeline
 * checks it again before building a query. It is the only value in this whole
 * file a person types freely, and it ends up inside a quoted identifier in a
 * statement sent to the company's accounting system. A double quote is
 * therefore refused, which is what makes the quoting downstream safe: the name
 * cannot terminate its own literal. The error names the rule, because "invalid
 * field" would send an operator looking at the wrong part of their setup.
 */
function validateMatchField(fieldName: string): void {
  if (!CUSTOM_FIELD_NAME.test(fieldName)) {
    throw new ValidationError(
      'invoiceMatching.fieldName must be a custom field name as QuickBooks shows it — letters, digits, spaces, hyphens and underscores only, up to 100 characters',
    );
  }
}

/**
 * Validate a write to the matching rule as a WHOLE rather than field by field.
 *
 * A partial write is legal and common — an operator changing the mode should
 * not have to resend the strategy — so the cross-field rule ("`customField`
 * needs a name") is checked against the value that will be stored, not against
 * what arrived. That needs the current row, so it is resolved here and passed
 * in.
 */
function validateMatchRule(update: InvoiceMatchingUpdate, current: InvoiceMatchingSettings): void {
  const strategy = update.strategy !== undefined ? update.strategy : current.strategy;
  const fieldName = update.fieldName !== undefined ? update.fieldName : current.fieldName;

  if (update.strategy !== undefined && update.strategy !== null) {
    if (!MATCH_STRATEGIES.includes(update.strategy)) {
      throw new ValidationError('invoiceMatching.strategy is not a supported matching rule');
    }
  }
  if (update.mode !== undefined && update.mode !== null && !MATCH_MODES.includes(update.mode)) {
    throw new ValidationError('invoiceMatching.mode must be "exact" or "contains"');
  }
  if (update.fieldName !== undefined && update.fieldName !== null) {
    validateMatchField(update.fieldName);
  }
  if (strategy === 'customField' && (fieldName === null || fieldName === '')) {
    throw new ValidationError(
      'invoiceMatching.fieldName is required when matching on a custom field — it is the field that holds the identifier',
    );
  }
}

/** Is the stored rule complete enough for the pipeline to run a payment through? */
function isMatchRuleReady(rule: InvoiceMatchingSettings): boolean {
  if (!rule.strategy) return false;
  if (rule.strategy === 'customField') {
    return typeof rule.fieldName === 'string' && rule.fieldName.length > 0;
  }
  return true;
}

/**
 * The four matching columns, lifted out of the settings row.
 *
 * One place that knows the column-to-field mapping, so the readiness check and
 * the runtime projection cannot disagree about which fields they are looking
 * at — the failure mode of a rule that is "complete" to one reader and missing
 * a field to the next.
 */
function matchRuleOf(settings: DeploymentSettings): InvoiceMatchingSettings {
  return {
    strategy: settings.invoiceMatchStrategy,
    mode: settings.invoiceMatchMode,
    fieldName: settings.invoiceMatchField,
    depositAccountId: settings.paymentDepositAccountId,
  };
}

/**
 * The matching rule as the pipeline receives it, or `null` when unconfigured.
 *
 * `null` is a REAL STATE, not an error: a deployment that has connected its
 * accounting system and has not yet said how payments should be matched cannot
 * place a payment anywhere, and the caller needs to say so in terms an operator
 * can act on. Returning a default instead would silently decide that a
 * student's identifier is their name.
 */
function toMatchConfig(rule: InvoiceMatchingSettings): CustomerMatchConfig | null {
  if (!isMatchRuleReady(rule) || !rule.strategy) return null;
  return {
    strategy: rule.strategy,
    mode: rule.mode ?? 'exact',
    fieldName: rule.fieldName,
    depositAccountId: rule.depositAccountId,
  };
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
  /**
   * `environment` is INJECTED so the stored-then-environment rule can be tested
   * against a chosen source rather than against whatever `setup-env.cjs` happens
   * to set — `env` is parsed once at import, so a test cannot arrange an empty
   * deployment any other way. Passing `{}` means "a deployment configured
   * entirely from the database", which is the other half of the rule.
   */
  constructor(
    private readonly repository: SettingsRepository = getRepositories().settings,
    private readonly environment: AppCredentialEnv = env,
  ) {}

  /** The write-only projection. No credential value appears in the result. */
  async getSettings(): Promise<PublicDeploymentSettings> {
    return toPublic(await this.repository.get(), env.ORGANIZATION_ID, secretsConfigured(), this.environment);
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
    const current = await this.repository.get();

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

  /**
   * The customer matching rule, written on its own.
   *
   * ★ ADMIN-ONLY, AND THE SEPARATION IS THE POINT. This used to be a key inside
   * `updateAdaptor`, reachable by any holder of `system.write` — because that
   * route is gated on `write OR admin`, and the two gates in sequence would
   * have required BOTH and locked out a legitimate administrator. So the rule
   * moved to its own route with its own authorization instead.
   *
   * That matters because of what this setting DOES. Every other field on this
   * page describes the connection; this one decides which customer's ledger a
   * real payment is applied to. Getting it wrong does not fail visibly — it
   * moves money against the wrong books, or matches nobody and quietly stops
   * posting. It is therefore not a preference a `write` holder should reach,
   * and the API is the only place that can say so; hiding the control in the
   * console would leave the capability exactly where it was.
   */
  async updateInvoiceMatching(
    update: InvoiceMatchingUpdate | null,
  ): Promise<PublicDeploymentSettings> {
    const current = await this.repository.get();
    const patch: DeploymentSettingsPatch = {};

    if (update === null) {
      // Clearing the whole rule in one instruction, spelled as `null`, so it is
      // never confused with "no opinion about any of it".
      patch.invoiceMatchStrategy = null;
      patch.invoiceMatchMode = null;
      patch.invoiceMatchField = null;
      patch.paymentDepositAccountId = null;
    } else {
      validateMatchRule(update, matchRuleOf(current));
      if (update.strategy !== undefined) patch.invoiceMatchStrategy = update.strategy;
      if (update.mode !== undefined) patch.invoiceMatchMode = update.mode;
      if (update.fieldName !== undefined) patch.invoiceMatchField = update.fieldName;
      if (update.depositAccountId !== undefined) {
        patch.paymentDepositAccountId = update.depositAccountId;
      }
    }

    return this.apply(patch, ['adaptor.invoiceMatching']);
  }

  /**
   * The matching rule the pipeline needs, or `null` when it is not configured.
   *
   * The ONLY reader of the rule outside the settings API, and it returns the
   * runtime `CustomerMatchConfig` rather than the stored row so no caller has
   * to know about the four columns or re-derive the `customField` completeness
   * rule — the one rule that decides whether a configured-looking setting can
   * actually run.
   */
  async resolveMatchConfig(): Promise<CustomerMatchConfig | null> {
    return toMatchConfig(matchRuleOf(await this.repository.get()));
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
      return toPublic(current, env.ORGANIZATION_ID, secretsConfigured(), this.environment);
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

  /**
   * The client id/secret pair the authorization exchange runs with, or `null`.
   *
   * ONE PLACE THE CONTROLLER READS THE PAIR FROM, and that is the reason it
   * exists as a method here rather than as a second reading of the row in the
   * connect flow: the button on the settings page, this resolution, and the
   * credentials the adaptor connects with all go through `resolveAppCredentials`,
   * so a flow cannot be started with a pair that the projection never offered (or
   * refused to offer).
   *
   * THE ROW IS READ WITH `repository.get()`, NOT `resolveCredentials()`. The
   * latter THROWS on a blob it cannot open, which is right for the adaptor — it
   * cannot connect with a credential it cannot read — and wrong here: a corrupt
   * row must not take down a flow that the environment can still complete. So the
   * stored side is caught and treated as absent, which is also what the
   * projection does.
   *
   * Stored-then-environment, exactly as `credentials.provider.ts` connects: a
   * stored set is used only when the row says which adaptor it belongs to, and
   * `baseUrl` follows the same split (the operator's override, else the
   * environment's for that adaptor) so the exchange is not sent somewhere the
   * adaptor would never have connected.
   */
  async resolveAppCredentials(): Promise<ResolvedAppCredentials | null> {
    let id: AdaptorId = env.ADAPTOR_ID;
    let stored: Record<string, unknown> | null = null;
    let storedBaseUrl: string | null = null;

    try {
      const settings = await this.repository.get();
      id = settings.adaptorId ?? env.ADAPTOR_ID;
      /*
        Attributable to the active adaptor, or not used at all — the row's
        `adaptorId` is the only record of whose credentials these are, and a set
        with no owner is the other system's.
      */
      if (settings.adaptorId !== null) {
        stored = storedFields(settings.adaptorCredentials);
        storedBaseUrl = settings.adaptorBaseUrl;
      }
    } catch (err) {
      logger.warn({ err }, 'Stored application credentials unreadable; falling back to environment');
    }

    const pair = resolveAppCredentials(id, stored, this.environment);
    if (!pair) {
      return null;
    }

    return {
      ...pair,
      baseUrl: storedBaseUrl ?? environmentAdaptorCredentials(id, this.environment).baseUrl ?? null,
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
    return toPublic(settings, env.ORGANIZATION_ID, secretsConfigured(), this.environment);
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
