/**
 * Configuration for the ONE organization this deployment serves.
 *
 * ONE DEPLOYMENT, ONE ORGANIZATION. There is no `organizations` table and no
 * tenant column: the deployment *is* the organization, so its configuration is a
 * single row rather than a collection. The organization's identity is
 * `env.ORGANIZATION_ID` (deployment-scoped, needed at boot before any human has
 * configured anything); everything an administrator sets lives here.
 *
 * SECRETS ARE NEVER STORED IN THE CLEAR. The two `…Secret`/`…Credentials` fields
 * hold a sealed envelope produced by `sealSecret()` — ciphertext with its key
 * version, nonce and auth tag attached — and there is no field on this type that
 * ever holds a credential in plaintext. A reader that needs the plaintext goes
 * through `SettingsService.resolveCredentials()` and is doing so server-side.
 *
 * PRIVACY UNCHANGED: this is configuration, not operations. No amounts, no
 * currency, and no customer data appear here, and `privacy.test.ts` keeps it
 * that way.
 */

import type { AdaptorId } from '../types/adaptor.js';
import type { CustomerMatchMode, CustomerMatchStrategy } from '../types/adaptor.js';

/** Which accounting system this deployment pushes to. One choice, not a set. */
export type ConfiguredAdaptorId = AdaptorId;

/**
 * The stored shape of the matching rule. Three of these four are a choice from
 * a list; `fieldName` is the single value an operator types.
 *
 * It is stored as four columns rather than one value on purpose — see
 * migration 006. The runtime shape is `CustomerMatchConfig`, which is what the
 * pipeline actually receives.
 */
export interface InvoiceMatchingSettings {
  strategy: CustomerMatchStrategy | null;
  mode: CustomerMatchMode | null;
  fieldName: string | null;
  depositAccountId: string | null;
}

export interface DeploymentSettings {
  /** Display name for the organization, set by the wizard. */
  organizationName: string | null;

  /* --- payment gateway --- */
  gatewayClientId: string | null;
  /** Sealed. `null` means "not configured", which is not the same as "empty". */
  gatewayWebhookSecret: Buffer | null;

  /* --- accounting system (exactly one) --- */
  adaptorId: ConfiguredAdaptorId | null;
  adaptorRealmId: string | null;
  adaptorBaseUrl: string | null;
  /** Sealed. `null` means "not configured". */
  adaptorCredentials: Buffer | null;

  /* --- invoice matching (migration 006) --- */
  /**
   * Where on an accounting customer the payment's identifier is looked for.
   * `null` means unconfigured, and the pipeline REFUSES to guess one — see
   * `WebhookProcessor.resolveMatchConfig`.
   */
  invoiceMatchStrategy: CustomerMatchStrategy | null;
  /** Exact or substring, for the strategies that support a choice. */
  invoiceMatchMode: CustomerMatchMode | null;
  /**
   * The accounting custom field's NAME. Required by, and only meaningful for,
   * the `customField` strategy. A name rather than a numeric id because that is
   * the only way the accounting query language can address the field.
   */
  invoiceMatchField: string | null;
  /**
   * Where received money is deposited. `null` omits the reference, so the
   * provider applies it to undeposited funds.
   */
  paymentDepositAccountId: string | null;

  /* --- operational preferences --- */
  /** Sync pull cadence (FR-3.3). Validated on read, never trusted as stored. */
  syncInterval: string | null;
  /** Where critical failures are reported. */
  alertTarget: string | null;

  /** When the connection was last proven to work, and when the wizard finished. */
  verifiedAt: string | null;
  configuredAt: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * A partial update.
 *
 * A key present with the value `null` CLEARS the field; a key that is absent
 * leaves it untouched. That distinction is the reason this is a plain `Partial`
 * and not a shape where `undefined` and `null` are interchangeable — "clear the
 * stored credential" and "leave the stored credential alone" are different
 * instructions, and conflating them would silently erase a working credential
 * whenever a form posted a field the operator never touched.
 */
export type DeploymentSettingsPatch = Partial<Omit<DeploymentSettings, 'createdAt' | 'updatedAt'>>;

/** The row before anything has been configured. */
export function defaultDeploymentSettings(now = new Date().toISOString()): DeploymentSettings {
  return {
    organizationName: null,
    gatewayClientId: null,
    gatewayWebhookSecret: null,
    adaptorId: null,
    adaptorRealmId: null,
    adaptorBaseUrl: null,
    adaptorCredentials: null,
    invoiceMatchStrategy: null,
    invoiceMatchMode: null,
    invoiceMatchField: null,
    paymentDepositAccountId: null,
    syncInterval: null,
    alertTarget: null,
    verifiedAt: null,
    configuredAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Drop keys the caller did not mean to set.
 *
 * `Partial<T>` permits an explicit `undefined`, and spreading it would CLEAR the
 * field — the opposite of what `{ name: undefined }` reads like. Both repositories
 * apply this rule so "absent" and "explicitly undefined" behave identically, and
 * only a present `null` clears a field.
 */
export function withoutUndefined(patch: DeploymentSettingsPatch): DeploymentSettingsPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as DeploymentSettingsPatch;
}
