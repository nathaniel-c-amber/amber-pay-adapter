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
import { ABILITY, SYSTEM_MANAGE } from "@/utils/permissions";
import {
  ApiRequestError,
  UnauthorizedError,
  beginQuickBooksConnect,
  getSettings,
  updateGatewaySettings,
  updateInvoiceMatchingSettings,
  updatePreferenceSettings,
  verifyAdaptor,
} from "@/services/client";
import { formatDateTime } from "@/utils/datetime";
import { adaptorChoice, readingForVerification, validateOrganizationName } from "@/utils/settingsRules";
import type { VerificationReading } from "@/utils/settingsRules";
import type {
  ApiDeploymentSettings,
  ApiInvoiceMatchMode,
  ApiInvoiceMatchStrategy,
} from "@/types/api";

type Section = "deployment" | "gateway" | "accounting" | "matching";

/**
 * The three places an identifier can live on an accounting customer.
 *
 * Offered as DATA so the select, the read-only summary and the warning about
 * cost cannot drift apart — they are three renderings of one list, and a fourth
 * strategy added to only one of them would leave the console describing a
 * choice it does not offer.
 *
 * The wording about speed is not marketing. QuickBooks rejects both a
 * `Notes like` filter and any custom-field filter with an HTTP 400, so ONLY the
 * name is a single call; the other two read customers a page at a time. That was
 * verified against the live company on 2026-09-28, and the console says so
 * before an operator chooses rather than after their payments stop posting.
 */
const MATCH_STRATEGY_OPTIONS: { value: ApiInvoiceMatchStrategy; label: string }[] = [
  { value: "displayName", label: "The customer name is the identifier" },
  { value: "customField", label: "In a custom field" },
  { value: "notes", label: "In the customer notes" },
];

const MATCH_STRATEGY_TEXT: Record<string, string> = Object.fromEntries(
  MATCH_STRATEGY_OPTIONS.map((option) => [option.value, option.label]),
);

const MATCH_MODE_TEXT: Record<ApiInvoiceMatchMode, string> = {
  exact: "Whole identifier",
  contains: "Part of the name",
};

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
  const [verified, setVerified] = useState<VerificationReading | null>(null);
  const [verifying, setVerifying] = useState(false);

  /*
    The matching rule, held as a draft rather than written straight from the
    loaded settings. Every section on this page keeps a draft, and the reason is
    the same for all of them: the field is write-only, so the value in `settings`
    is the LAST SAVED one, and binding the inputs to it would mean a reload
    silently discards what somebody typed.
  */
  const [strategy, setStrategy] = useState<ApiInvoiceMatchStrategy | "">("");
  const [matchMode, setMatchMode] = useState<ApiInvoiceMatchMode>("exact");
  const [fieldName, setFieldName] = useState("");
  const [depositAccountId, setDepositAccountId] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const loaded = await getSettings(token);
      setSettings(loaded);
      setLoadError(null);
      setName(loaded.organizationName ?? "");
      setClientId(loaded.gateway.clientId ?? "");
      const rule = loaded.adaptor.invoiceMatching;
      setStrategy(rule.strategy ?? "");
      setMatchMode(rule.mode ?? "exact");
      setFieldName(rule.fieldName ?? "");
      setDepositAccountId(rule.depositAccountId ?? "");
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

  /**
   * Save the matching rule.
   *
   * Sends ONLY the fields that changed, because the server validates the rule as
   * a whole against the value that will be STORED — so resending an untouched
   * field as an empty string would be read as "clear this one field", and a
   * half-typed custom-field name would clear the very field the rule depends on.
   */
  const saveMatching = async () => {
    if (!token || !settings) return;
    if (!strategy) {
      note("matching", "error", "Choose where the identifier is found on the customer.");
      return;
    }
    if (strategy === "customField" && fieldName.trim().length === 0) {
      note(
        "matching",
        "error",
        "Matching on a custom field needs the field's name — it is what holds the identifier.",
      );
      return;
    }
    const current = settings.adaptor.invoiceMatching;
    setBusy("matching");
    try {
      const next = await updateInvoiceMatchingSettings(token, {
        strategy,
        ...(matchMode !== (current.mode ?? "exact") ? { mode: matchMode } : {}),
        // Absent when unchanged, so the server keeps what is stored rather than
        // being handed a blank it would have to treat as an instruction.
        ...(strategy === "customField" && fieldName.trim() !== (current.fieldName ?? "")
          ? { fieldName: fieldName.trim() }
          : {}),
        ...(depositAccountId.trim() !== (current.depositAccountId ?? "")
          ? { depositAccountId: depositAccountId.trim() || null }
          : {}),
      });
      setSettings(next);
      note("matching", "ok", "Saved. Completed payments will be matched using this rule.");
    } catch (err) {
      note("matching", "error", messageOf(err));
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
   * FETCH the URL, THEN navigate. The server holds the client secret and must
   * never send it here, so it builds the authorization URL itself; but this
   * endpoint requires a bearer token and a browser navigation carries none, so
   * navigating to it directly is refused before it begins. Two calls, in this
   * order.
   *
   * The provider sends the browser back to the guided setup, which reports the
   * outcome. It does NOT return here: honouring a caller-supplied return path would
   * mean reflecting an unvalidated URL into a `Location` header, and the wizard is
   * the surface that already knows how to read the result.
   */
  const startConnect = async () => {
    setBusy('accounting');
    try {
      const url = await beginQuickBooksConnect(token!);
      // Cannot fire today — the URL is built by our own server — but a future
      // change to how it is assembled must not turn this button into a way to send
      // an operator's browser somewhere unexpected.
      if (new URL(url).hostname !== 'appcenter.intuit.com') {
        note('accounting', 'error', 'The connection could not be started, so nothing was changed.');
        return;
      }
      window.location.assign(url);
    } catch (err) {
      note('accounting', 'error', messageOf(err));
    } finally {
      setBusy(null);
    }
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

      <Card title="Payment Gateway">
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
                  onClick={() => void startConnect()}
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

      {/*
        THE MATCHING RULE — READ FOR EVERYONE, WRITTEN BY AN ADMINISTRATOR ONLY.

        The asymmetry is the design. An operator who cannot SEE the rule cannot
        tell whether a completed payment is being matched to the right student,
        and that is the question this page exists to answer. So a reader gets the
        rule stated in full and no control, and `<Cannot>` says why in one line
        rather than leaving a reader to wonder whether an omission is a bug.

        The control is hidden rather than disabled, which is the console's
        standing rule for a denied surface. Hiding it is a courtesy, not the
        control: the server refuses the write for a non-administrator, and
        `PUT /settings/invoice-matching` is gated on `admin` alone.
      */}
      <Card title="Matching a payment to a customer">
        <div className="flex flex-col gap-4">
          <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
            When a payment completes, the reference the gateway sent is looked up on the accounting
            system to find the customer it belongs to, and this rule says where to look. An identifier
            that matches more than one customer is refused rather than guessed, so a payment is never
            applied to the wrong ledger.
          </p>

          {/*
            THE CONFIGURED RULE, ALWAYS SHOWN — including to a reader, and
            including when nothing is set. "No rule configured" is itself the
            answer to "why did the last payment not post", and rendering only the
            editable form would have made that state invisible to everyone but the
            one person who caused it.
          */}
          <dl className="m-0 flex flex-col">
            <Fact label="Where the identifier is found" value={MATCH_STRATEGY_TEXT[strategy] ?? "Not set"} />
            <Fact label="Match" value={strategy ? MATCH_MODE_TEXT[matchMode] : "—"} />
            <Fact
              label="Field"
              value={strategy === "customField" ? fieldName || "Not set" : "—"}
            />
            <Fact
              label="Deposit account"
              value={depositAccountId || "Undeposited funds"}
            />
          </dl>

          {!settings.adaptor.invoiceMatching.strategy && (
            <div className="rounded-panel border border-state-delayed bg-midnight-2 px-4 py-3">
              <p className="m-0 text-md font-semibold text-state-delayed">No matching rule is set</p>
              <p className="m-0 mt-1 max-w-[62ch] text-sm leading-prose text-ink-2">
                A completed payment has nowhere to go, so it is held rather than posted. This is
                the reason a payment can complete and still not appear in the accounting system.
              </p>
            </div>
          )}

          <Can ability={ABILITY.systemAdmin}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label
                  className="mono text-micro uppercase tracking-label text-ink-3"
                  htmlFor="cfg-strategy"
                >
                  Where the identifier is found
                </label>
                <select
                  id="cfg-strategy"
                  className={INPUT}
                  value={strategy}
                  onChange={(event) =>
                    setStrategy(event.target.value as ApiInvoiceMatchStrategy | "")
                  }
                  aria-describedby="cfg-strategy-hint"
                >
                  <option value="">Not set</option>
                  {MATCH_STRATEGY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p id="cfg-strategy-hint" className="m-0 text-xs leading-prose text-ink-3">
                  {strategy === "notes"
                    ? "QuickBooks cannot search a customer's notes, so this looks at them page by page — slower, and metered against the provider's limits."
                    : strategy === "customField"
                      ? "QuickBooks cannot search a custom field either, so the field you name below is read from customers one at a time. It works; it is not instant."
                      : strategy === "displayName"
                        ? "A single lookup — but the reference the gateway sends has no spaces in it, so this only works where the customer's name is the identifier itself."
                        : "Choose where the identifier is found."}
                </p>
              </div>

              {strategy === "customField" && (
                <div className="flex flex-col gap-1">
                  <label
                    className="mono text-micro uppercase tracking-label text-ink-3"
                    htmlFor="cfg-field"
                  >
                    Custom field name
                  </label>
                  <input
                    id="cfg-field"
                    className={INPUT}
                    value={fieldName}
                    onChange={(event) => setFieldName(event.target.value)}
                    placeholder="Student ID"
                    aria-describedby="cfg-field-hint"
                  />
                  <p id="cfg-field-hint" className="m-0 text-xs leading-prose text-ink-3">
                    The name exactly as the accounting system shows it, spaces included.
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label
                  className="mono text-micro uppercase tracking-label text-ink-3"
                  htmlFor="cfg-mode"
                >
                  Match
                </label>
                <select
                  id="cfg-mode"
                  className={INPUT}
                  value={matchMode}
                  onChange={(event) => setMatchMode(event.target.value as ApiInvoiceMatchMode)}
                  aria-describedby="cfg-mode-hint"
                >
                  <option value="exact">Whole identifier</option>
                  <option value="contains">Part of the name</option>
                </select>
                <p id="cfg-mode-hint" className="m-0 text-xs leading-prose text-ink-3">
                  {matchMode === "exact"
                    ? "Matches one customer, or none."
                    : "Matches anything containing the identifier, so a short one can match more than one customer — and that is refused, not guessed."}
                </p>
              </div>

              <div className="flex flex-col gap-1">
                <label
                  className="mono text-micro uppercase tracking-label text-ink-3"
                  htmlFor="cfg-deposit"
                >
                  Deposit account
                </label>
                <input
                  id="cfg-deposit"
                  className={INPUT}
                  value={depositAccountId}
                  onChange={(event) => setDepositAccountId(event.target.value)}
                  placeholder="Undeposited funds"
                  aria-describedby="cfg-deposit-hint"
                />
                <p id="cfg-deposit-hint" className="m-0 text-xs leading-prose text-ink-3">
                  Optional. Left blank, received money goes to undeposited funds.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  onClick={() => void saveMatching()}
                  disabled={busy !== null}
                >
                  Save matching rule
                </button>
                {outcome.matching && (
                  <Outcome tone={outcome.matching.tone}>{outcome.matching.text}</Outcome>
                )}
              </div>
            </div>
          </Can>

          <Cannot ability={ABILITY.systemAdmin}>
            <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-3">
              Only a scope with the <code>admin</code> action can change this rule. It decides which
              customer's ledger a payment is applied to, so it is deliberately narrower than the rest
              of this page.
            </p>
          </Cannot>
        </div>
      </Card>

      {/*
        THE SYNC CADENCE PANEL WAS REMOVED, not made more verbose.

        Asked for more explanation here, and the honest answer was that there was
        nothing to explain: nothing reads `syncInterval` or `alertTarget`, and
        there is no scheduler in the service at all — `pullSyncStatus` is never
        called outside the adaptors' own definitions. So this was a control with no
        behaviour behind it, which is precisely the invented "every 15 min" and
        "≤ 5 s" panel this page used to ship.

        Describing it more thoroughly would only have made a dead control more
        convincing. The two columns remain on the row for the day something reads
        them; a setting that stores and is never consulted is a lie in a settings
        page, whoever typed into it.
      */}
    </div>
  );
}
