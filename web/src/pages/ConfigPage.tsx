/* System configuration, read from and written to the real deployment settings.
 *
 * THIS PAGE USED TO BE THEATRE, and it said so: with no configuration endpoint to
 * read, it rendered "this deployment exposes no configuration endpoint" beside a
 * Save button that set a boolean, and a column of invented cadence figures ("every
 * 15 min", "≤ 5 s") that no code enforced. A settings page reporting values nothing
 * consumes is worse than an empty one — somebody will change a number here and wait
 * for it to take effect.
 *
 * WHAT IT DOES NOW: reads `GET /settings`, writes each section to its own endpoint,
 * and hands the parts that need more than one value to be coherent (which
 * accounting system, and proving it works) to the guided setup.
 *
 * PER-SECTION SAVE, deliberately, rather than the single button it had. The sections
 * are different requests with different failure modes, and one button that fires all
 * of them either reports a partial success as success or refuses to save the field
 * that was fine. Each section owns its own outcome line, so "Saved" always means the
 * thing beside it.
 *
 * SECRETS ARE WRITE-ONLY, and the form is shaped around that rather than pretending
 * otherwise: a stored secret appears as presence plus its last four characters, the
 * input starts empty, and empty means "keep what is there" — the only workable rule
 * when the value cannot be read back.
 */

import { useCallback, useEffect, useState } from "react";
import { IconEdit, IconLedger, IconServer } from "@/components/icons";
import { BTN, BTN_PRIMARY, Card, DemoTag, INPUT, LINK_BTN, PageHeader, cx } from "@/components/ui";
import { Can, Cannot } from "@/components/Can";
import { SYSTEM_MANAGE } from "@/utils/permissions";
import {
  ApiRequestError,
  UnauthorizedError,
  getSettings,
  updateGatewaySettings,
  updatePreferenceSettings,
  verifyAdaptor,
} from "@/services/client";
import { formatDateTime } from "@/utils/datetime";
import { adaptorChoice, readingForVerification, validateOrganizationName } from "@/utils/settingsRules";
import type { VerificationReading } from "@/utils/settingsRules";
import type { ApiDeploymentSettings } from "@/types/api";

type Section = "deployment" | "gateway" | "accounting" | "cadence";

function messageOf(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "The request could not be completed.";
}

/** Presence and last four, in the operator's terms. */
function CredentialLine({
  label,
  presence,
}: {
  label: string;
  presence: { configured: boolean; lastFour: string | null; unreadable: boolean };
}) {
  let value: string;
  let tone: string;
  if (!presence.configured) {
    value = "Not set";
    tone = "text-ink-3";
  } else if (presence.unreadable) {
    /* Its own state rather than a flavour of "not set": overwriting a credential
       that is probably still correct under a key this process lacks is the wrong
       move, and that is a different instruction to give an operator. */
    value = "Stored, but not readable with the current key";
    tone = "text-text-suspended";
  } else {
    value = presence.lastFour ? `Stored ····${presence.lastFour}` : "Stored";
    tone = "text-ink-1";
  }
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
      <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">{label}</dt>
      <dd className={cx("mono m-0 min-w-0 text-right text-md wrap-anywhere", tone)}>{value}</dd>
    </div>
  );
}

/** A section's outcome line: the only place a section claims something happened. */
function Outcome({ tone, children }: { tone: "ok" | "error"; children: React.ReactNode }) {
  return (
    <p
      className={cx("m-0 text-sm", tone === "ok" ? "text-line-green" : "text-text-suspended")}
      {...(tone === "error" ? { role: "alert" } : { role: "status" })}
    >
      {children}
    </p>
  );
}

/** A read-only fact row. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
      <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">{label}</dt>
      <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{value}</dd>
    </div>
  );
}

export function ConfigPage({
  token,
  mode,
  onRequireSignIn,
}: {
  token: string | null;
  mode: "demo" | "live";
  /** Called when the session turns out to be dead, so the shell can say so. */
  onRequireSignIn: () => void;
}) {
  const [settings, setSettings] = useState<ApiDeploymentSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Section | null>(null);
  const [outcome, setOutcome] = useState<
    Partial<Record<Section, { tone: "ok" | "error"; text: string }>>
  >({});

  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [syncInterval, setSyncInterval] = useState("");
  const [alertTarget, setAlertTarget] = useState("");
  const [verified, setVerified] = useState<VerificationReading | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const loaded = await getSettings(token);
      setSettings(loaded);
      setLoadError(null);
      setName(loaded.organizationName ?? "");
      setClientId(loaded.gateway.clientId ?? "");
      setSyncInterval(loaded.syncInterval ?? "");
      setAlertTarget(loaded.alertTarget ?? "");
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onRequireSignIn();
        return;
      }
      setLoadError(messageOf(err));
    }
  }, [token, onRequireSignIn]);

  useEffect(() => {
    void load();
  }, [load]);

  const note = useCallback((section: Section, tone: "ok" | "error", text: string) => {
    setOutcome((current) => ({ ...current, [section]: { tone, text } }));
  }, []);

  const saveDeployment = async () => {
    if (!token) return;
    const invalid = validateOrganizationName(name);
    if (invalid) {
      note("deployment", "error", invalid);
      return;
    }
    setBusy("deployment");
    try {
      const next = await updatePreferenceSettings(token, { organizationName: name.trim() });
      setSettings(next);
      note("deployment", "ok", "Saved.");
    } catch (err) {
      note("deployment", "error", messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const saveCadence = async () => {
    if (!token) return;
    setBusy("cadence");
    try {
      // Separate from the name on purpose: a cadence change must not be blocked by an
      // empty name box. Coupling unrelated fields is how a save button starts
      // refusing work it should do.
      const next = await updatePreferenceSettings(token, {
        syncInterval: syncInterval.trim() || null,
        alertTarget: alertTarget.trim() || null,
      });
      setSettings(next);
      note("cadence", "ok", "Saved.");
    } catch (err) {
      note("cadence", "error", messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const saveGateway = async () => {
    if (!token || !settings) return;
    if (clientId.trim().length === 0 && settings.gateway.clientId === null) {
      note("gateway", "error", "The gateway client id is required.");
      return;
    }
    setBusy("gateway");
    try {
      const next = await updateGatewaySettings(token, {
        clientId: clientId.trim(),
        /* Absent, never null: an empty box means "keep the stored secret". An
           explicit null would erase a credential the operator cannot read back. */
        ...(webhookSecret.trim().length > 0 ? { webhookSecret: webhookSecret.trim() } : {}),
      });
      setSettings(next);
      setWebhookSecret("");
      note("gateway", "ok", "Saved. The stored secret is in use for the next delivery.");
    } catch (err) {
      note("gateway", "error", messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    if (!token || !settings?.adaptor.id) return;
    setVerifying(true);
    setVerified(null);
    try {
      /* No credentials in the body: this tests what is STORED, which is what the
         pipeline actually uses, and a pass records when it was verified — which is
         the fact this page displays. */
      const result = await verifyAdaptor(token, {});
      setVerified(readingForVerification(result));
      await load();
    } catch (err) {
      note("accounting", "error", messageOf(err));
    } finally {
      setVerifying(false);
    }
  };

  /**
   * Start the provider authorization.
   *
   * A NAVIGATION, not a fetch: the next hop is a human signing in at the provider.
   * The server reads the stored client secret when it builds the authorization URL,
   * which is precisely why this secret is never sent to the browser.
   *
   * The provider sends the browser back to the guided setup, which reports the
   * outcome. It does NOT return here: honouring a caller-supplied return path would
   * mean reflecting an unvalidated URL into a `Location` header, and the wizard is
   * the surface that already knows how to read the result.
   */
  const startConnect = () => {
    window.location.assign('/api/v1/settings/adaptor/connect');
  };

  if (mode === "demo" || !token) {
    return (
      <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
        <PageHeader
          title="System configuration"
          lead="This deployment's gateway, accounting system and preferences."
          actions={<DemoTag />}
        />
        <Card title="Configuration">
          {/* A demo session has no deployment behind it. Rendering settings that look
              real here is precisely the failure this console exists to avoid. */}
          <p className="m-0 max-w-[62ch] text-md leading-prose text-ink-2">
            Configuration is not available in a demonstration session. It is read from the
            deployment itself, and these figures are synthetic.
          </p>
        </Card>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="System configuration" lead="This deployment's configuration." />
        <Card title="Configuration">
          <p className="m-0 max-w-[62ch] text-md leading-prose text-ink-2">{loadError}</p>
          <button type="button" className={cx(BTN, "mt-3")} onClick={() => void load()}>
            Try again
          </button>
        </Card>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="System configuration" lead="This deployment's configuration." />
        <Card title="Configuration">
          <p className="m-0 text-md text-ink-2" role="status">
            Loading this deployment's configuration…
          </p>
        </Card>
      </div>
    );
  }

  const choice = adaptorChoice(settings.adaptor.id);

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="System configuration"
        lead="This deployment's gateway, accounting system and preferences."
        actions={
          <a className={BTN} href="#/onboarding">
            <IconLedger /> Run guided setup
          </a>
        }
      />

      <Cannot ability={SYSTEM_MANAGE}>
        <div className="flex items-center gap-2 rounded-panel border border-[rgb(230_161_42/0.4)] bg-state-tint-delayed px-3 py-2 text-sm text-text-delayed [&_svg]:animate-warn">
          Your active scope can view this configuration but not change it. Selecting a scope with
          the <code>admin</code> or <code>write</code> action unlocks editing.
        </div>
      </Cannot>

      {!settings.configured && (
        <div className="rounded-panel border border-state-delayed bg-midnight-2 px-4 py-3">
          <p className="m-0 text-md font-semibold text-state-delayed">Setup has not been finished</p>
          <p className="m-0 mt-1 max-w-[62ch] text-sm leading-prose text-ink-2">
            This deployment has never recorded that it was set up. If it is already configured from
            its environment, run the guided setup and skip it — skipping records the fact, and stops
            the console offering it again.
          </p>
        </div>
      )}

      {!settings.writable && (
        <div className="rounded-panel border border-text-suspended bg-midnight-2 px-4 py-3">
          <p className="m-0 text-md font-semibold text-text-suspended">
            Credentials cannot be stored on this deployment
          </p>
          <p className="m-0 mt-1 max-w-[62ch] text-sm leading-prose text-ink-2">
            No <code className="mono">SECRETS_KEY</code> is set, so the API refuses every credential
            write. Generate one with <code className="mono">openssl rand -hex 32</code>, set it in the
            environment, and restart the API.
          </p>
        </div>
      )}

      <Card title="This deployment">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="mono text-micro uppercase tracking-label text-ink-3" htmlFor="cfg-name">
              Organization name
            </label>
            <input
              id="cfg-name"
              className={INPUT}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="organization"
              aria-describedby="cfg-name-hint"
            />
            <p className="m-0 max-w-[62ch] text-xs leading-prose text-ink-3" id="cfg-name-hint">
              This deployment serves one organization, so its name is the organization's name. It
              appears in the page header, the browser tab, and the emails people are invited to.
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-panel border border-rule-enamel-soft bg-midnight-2 p-3">
            <span className="mono text-micro uppercase tracking-label text-ink-3">Organization ID</span>
            <code className="mono text-md text-ink-1">{settings.organizationId}</code>
            <p className="m-0 max-w-[62ch] text-xs leading-prose text-ink-3">
              Read-only: set when the deployment was provisioned. Every stored row and every access
              grant is filed under it, so editing it here would hide the records already held.
            </p>
          </div>

          <dl className="m-0 flex flex-col">
            <Fact
              label="Setup finished"
              value={settings.configuredAt ? formatDateTime(settings.configuredAt) : "Not yet"}
            />
          </dl>

          <Can ability={SYSTEM_MANAGE}>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={BTN_PRIMARY}
                onClick={saveDeployment}
                disabled={busy !== null}
              >
                <IconEdit /> {busy === "deployment" ? "Saving…" : "Save name"}
              </button>
              {outcome.deployment && (
                <Outcome tone={outcome.deployment.tone}>{outcome.deployment.text}</Outcome>
              )}
            </div>
          </Can>
        </div>
      </Card>

      <Card title="Gateway">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label
              className="mono text-micro uppercase tracking-label text-ink-3"
              htmlFor="cfg-client-id"
            >
              Client ID
            </label>
            <input
              id="cfg-client-id"
              className={INPUT}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              className="mono text-micro uppercase tracking-label text-ink-3"
              htmlFor="cfg-webhook-secret"
            >
              Webhook secret
            </label>
            <input
              id="cfg-webhook-secret"
              className={INPUT}
              type="password"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                settings.gateway.webhookSecret.configured ? "Leave blank to keep the stored secret" : ""
              }
              aria-describedby="cfg-webhook-hint"
            />
            <p className="m-0 max-w-[62ch] text-xs leading-prose text-ink-3" id="cfg-webhook-hint">
              Stored encrypted and never shown again. Leaving it blank keeps the current secret — the
              only workable rule when the value cannot be read back.
            </p>
          </div>

          <dl className="m-0 flex flex-col">
            <CredentialLine label="Stored secret" presence={settings.gateway.webhookSecret} />
          </dl>

          <Can ability={SYSTEM_MANAGE}>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={BTN_PRIMARY}
                onClick={saveGateway}
                disabled={busy !== null}
              >
                <IconEdit /> {busy === "gateway" ? "Saving…" : "Save gateway"}
              </button>
              {outcome.gateway && <Outcome tone={outcome.gateway.tone}>{outcome.gateway.text}</Outcome>}
            </div>
          </Can>
        </div>
      </Card>

      <Card title="Accounting system">
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <span
              className="grid size-9 flex-none place-items-center rounded-panel bg-secondary-soft text-secondary-ink"
              aria-hidden
            >
              <IconServer />
            </span>
            <div className="min-w-0">
              <p className="m-0 text-md font-semibold text-ink-1">
                {choice?.label ?? "No accounting system chosen"}
              </p>
              <p className="m-0 text-sm leading-prose text-ink-3">
                {choice?.blurb ??
                  "This deployment has not been told which accounting system it integrates with."}
              </p>
            </div>
          </div>

          <dl className="m-0 flex flex-col">
            <Fact label="Company / realm" value={settings.adaptor.realmId ?? "—"} />
            <CredentialLine label="Credentials" presence={settings.adaptor.credentials} />
            <Fact
              label="Last verified"
              value={settings.verifiedAt ? formatDateTime(settings.verifiedAt) : "Never"}
            />
          </dl>

          {/* Changing WHICH system this deployment uses is a setup action rather than a
              field: it needs that system's credentials and a successful test, and
              doing it from a settings form would leave the deployment pointed at a
              system it has never connected to. */}
          <p className="m-0 max-w-[62ch] text-xs leading-prose text-ink-3">
            To change the accounting system, use the guided setup — the choice and its credentials
            are saved and authorized together there.
          </p>

          <Can ability={SYSTEM_MANAGE}>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={BTN}
                onClick={() => void testConnection()}
                disabled={verifying || busy !== null || !settings.adaptor.id}
              >
                {verifying ? "Testing…" : "Test connection"}
              </button>
              {/*
                THE REPLACE-CREDENTIALS PATH, and the reason this page had a dead end.
                Before the browser-authorization flow, a deployment whose stored
                client credentials needed changing could only be fixed by retyping
                values the console could not show and the operator had not kept a copy
                of. The app credentials CAN be retyped — they live in the provider's
                developer console — so this button always has a path behind it.
              */}
              {settings.adaptor.id === 'quickbooks' && (
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  onClick={startConnect}
                  disabled={!settings.adaptor.canAuthorize || busy !== null}
                  {...(settings.adaptor.canAuthorize
                    ? {}
                    : {
                        title:
                          'Save a client ID and client secret first — the authorization URL is built on the server, so the secret is never sent to this browser.',
                      })}
                >
                  Re-authorize with QuickBooks
                </button>
              )}
              <a className={LINK_BTN} href="#/onboarding">
                Guided setup
              </a>
              {outcome.accounting && (
                <Outcome tone={outcome.accounting.tone}>{outcome.accounting.text}</Outcome>
              )}
            </div>
          </Can>

          <p className="sr-only" role="status" aria-live="polite">
            {verifying ? "Testing the connection to the accounting system." : ""}
          </p>

          {verified && (
            <div
              className={cx(
                "rounded-panel border p-3",
                verified.ok ? "border-line-green" : "border-text-suspended",
              )}
            >
              <p
                className={cx(
                  "m-0 text-md font-semibold",
                  verified.ok ? "text-line-green" : "text-text-suspended",
                )}
                role="status"
              >
                {verified.headline}
              </p>
              <p className="m-0 mt-1 max-w-[62ch] text-sm leading-prose text-ink-2">
                {verified.detail}
              </p>
            </div>
          )}
        </div>
      </Card>

      <Card title="Sync cadence and alerting">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="mono text-micro uppercase tracking-label text-ink-3" htmlFor="cfg-sync">
              Scheduled sync interval
            </label>
            <input
              id="cfg-sync"
              className={INPUT}
              value={syncInterval}
              onChange={(event) => setSyncInterval(event.target.value)}
              placeholder="5m"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="cfg-sync-hint"
            />
            <p className="m-0 max-w-[62ch] text-xs leading-prose text-ink-3" id="cfg-sync-hint">
              A duration such as <code className="mono">30s</code>, <code className="mono">5m</code> or{" "}
              <code className="mono">1h</code>. The API refuses a value it cannot parse rather than
              falling back to a schedule nobody chose.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="mono text-micro uppercase tracking-label text-ink-3" htmlFor="cfg-alert">
              Alert target
            </label>
            <input
              id="cfg-alert"
              className={INPUT}
              value={alertTarget}
              onChange={(event) => setAlertTarget(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <Can ability={SYSTEM_MANAGE}>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={BTN_PRIMARY} onClick={saveCadence} disabled={busy !== null}>
                <IconEdit /> {busy === "cadence" ? "Saving…" : "Save cadence"}
              </button>
              {outcome.cadence && <Outcome tone={outcome.cadence.tone}>{outcome.cadence.text}</Outcome>}
            </div>
          </Can>
        </div>
      </Card>
    </div>
  );
}
