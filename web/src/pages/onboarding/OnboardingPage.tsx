/* First-run setup for a deployment. Reachable at `#/onboarding`, signed in.
 *
 * WHY THIS SITS OUTSIDE THE CONSOLE CHROME. It runs once, before the console has
 * anything true to show: a deployment with no gateway credentials and no accounting
 * system has no pipeline to monitor, and the console's own answer to that state is
 * a page of empty panels. A focused surface with a visible end is the honest
 * presentation of "this is not set up yet", and it is the same decision the auth
 * screens already made — they live at the root of the app, share the design tokens,
 * and keep the console's furniture out of the way.
 *
 * PROGRESS IS DERIVED FROM THE SERVER, not stored in the browser. Where the wizard
 * resumes is a function of what this deployment actually has configured
 * (`firstIncompleteStep`), so it is the same answer from another machine, it cannot
 * disagree with the row being written, and a half-typed form is never mistaken for
 * a half-finished setup.
 *
 * ONE STEP IS NOT A FORM. Step 3 asks for a choice and then for the fields of the
 * chosen system, generated from `ADAPTOR_CHOICES` rather than hand-built per
 * product — adding a third accounting system stays a data change, which is the
 * adaptor interface's whole premise.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthField } from "@/components/auth/AuthShell";
import { Stepper } from "@/components/onboarding/Stepper";
import { BTN, BTN_PRIMARY, INPUT, LINK_BTN, cx } from "@/components/ui";
import { IconLedger } from "@/components/icons";
import {
  ApiRequestError,
  completeSettings,
  getSettings,
  inviteUser,
  updateAdaptorSettings,
  updateGatewaySettings,
  updatePreferenceSettings,
  verifyAdaptor,
} from "@/services/client";
import { formatDateTime } from "@/utils/datetime";
import {
  ADAPTOR_CHOICES,
  INVITE_PRESETS,
  WIZARD_STEPS,
  adaptorChoice,
  connectOutcomeFromSearch,
  firstIncompleteStep,
  readingForVerification,
  stepAt,
  stepIndex,
  validateAccounting,
  validateGateway,
  validateInviteEmail,
  validateOrganizationName,
} from "@/utils/settingsRules";
import type { AccountingValues, GatewayValues, WizardStepId } from "@/utils/settingsRules";
import type { ApiAdaptorId, ApiAdaptorVerification, ApiDeploymentSettings } from "@/types/api";

/** A message for a failed request that does not invent a cause. */
function messageOf(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "The request could not be completed.";
}

interface FieldError {
  field: string;
  label: string;
  message: string;
}

type Busy = "name" | "gateway" | "accounting" | "verify" | "invite" | "finish" | null;

export function OnboardingPage({
  token,
  onDone,
  onLeave,
}: {
  token: string;
  /** Setup finished — hand over to the console. */
  onDone: () => void;
  /** Leave without finishing (the console can be opened read-only). */
  onLeave: () => void;
}) {
  const [settings, setSettings] = useState<ApiDeploymentSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stepId, setStepId] = useState<WizardStepId>("organization");
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  // Field state per step.
  const [organizationName, setOrganizationName] = useState("");
  const [gateway, setGateway] = useState<GatewayValues>({ clientId: "", webhookSecret: "" });
  const [adaptorId, setAdaptorId] = useState<ApiAdaptorId | null>(null);
  const [accounting, setAccounting] = useState<AccountingValues>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [verification, setVerification] = useState<ApiAdaptorVerification | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePreset, setInvitePreset] = useState<string>("operator");
  const [invited, setInvited] = useState<Array<{ email: string; link?: string }>>([]);

  /*
    Coming back from the provider's consent screen.
 *
    The server redirects back here with a `?connect=` marker, so the outcome has to
    be read on ARRIVAL rather than held in component state: the browser left the
    page entirely, and a useEffect that consumed a flag would have been clobbered by
    the unmount. The copy is chosen from a reason code rather than from whatever the
    provider sent, because a redirect URL is somewhere detail leaks.
  */
  const [returnFrom, setReturnFrom] = useState<{ connected: boolean; realm: string | null; message: string | null }>({
    connected: false,
    realm: null,
    message: null,
  });

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const seededRef = useRef(false);

  const step = stepAt(stepIndex(stepId));

  /** Seed the form from the server once, without clobbering what is being typed. */
  useEffect(() => {
    let cancelled = false;
    getSettings(token)
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        if (seededRef.current) return;
        seededRef.current = true;
        setOrganizationName(loaded.organizationName ?? "");
        setGateway({ clientId: loaded.gateway.clientId ?? "", webhookSecret: "" });
        setAdaptorId(loaded.adaptor.id);
        setAccounting({
          clientId: '',
          clientSecret: '',
          baseUrl: loaded.adaptor.baseUrl ?? '',
        });
        setStepId(firstIncompleteStep(loaded));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // A new step is a new context: move focus to its heading, exactly as the auth
  // screens do, so a keyboard user is not left at the bottom of a form that changed.
  useEffect(() => {
    headingRef.current?.focus();
  }, [stepId]);

  /*
    Read the provider's return, once, on arrival.

    The credential fields are re-read here because the callback may have STORED a
    refresh token and a company: the form was submitted, the browser left, and what
    comes back is not what was typed. Re-seeding from the server is also what stops
    the screen claiming a connection that the exchange refused.
  */
  useEffect(() => {
    if (!settings) return;
    const outcome = connectOutcomeFromSearch(window.location.search);
    if (!outcome.connected && !outcome.message) return;

    setReturnFrom(outcome);
    setVerification(null);
    if (outcome.connected) {
      setStepId('verify');
    } else {
      setStepId('accounting');
    }
    // Re-read so a completed connect shows the company and stored credentials.
    void (async () => {
      try {
        setSettings(await getSettings(token));
      } catch {
        // The outcome line is already on screen; failing to refresh it is not worth
        // replacing that with an error.
      }
    })();
    // Strip the marker so a later reload does not replay an outcome that is no
    // longer true, and so the URL stops carrying a result nobody asked about.
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, [settings, token]);

  const furthestReachable = useMemo(() => {
    if (!settings) return 0;
    /*
      A system that authorizes in the browser cannot reach the test step until the
      GRANT exists, not merely until the credentials are typed. Letting the stepper
      skip ahead would offer to test a connection that has never been authorized,
      which fails with "not authorized" and sends the operator looking for a
      credential problem they do not have.
    */
    const serverAnswer = stepIndex(firstIncompleteStep(settings));
    if (adaptorId === 'quickbooks' && !settings.adaptor.canAuthorize) {
      return Math.min(serverAnswer, stepIndex('accounting'));
    }
    return Math.max(serverAnswer, stepIndex(stepId));
  }, [settings, stepId, adaptorId]);

  const fail = useCallback((fields: FieldError[], message?: string) => {
    setErrors(fields);
    setFailure(message ?? null);
    // The summary is focusable and takes focus on failure: an error announced only
    // by colour above the fold is an error most people never read.
    requestAnimationFrame(() => summaryRef.current?.focus());
  }, []);

  const clearErrors = useCallback(() => {
    setErrors([]);
    setFailure(null);
  }, []);

  const goTo = useCallback(
    (id: WizardStepId) => {
      clearErrors();
      setStepId(id);
    },
    [clearErrors],
  );

  const submitOrganization = async () => {
    const invalid = validateOrganizationName(organizationName);
    if (invalid) {
      fail([{ field: "organizationName", label: "Name", message: invalid }]);
      return;
    }
    setBusy("name");
    try {
      const next = await updatePreferenceSettings(token, { organizationName: organizationName.trim() });
      setSettings(next);
      goTo("gateway");
    } catch (err) {
      fail([], messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const submitGateway = async () => {
    const invalid = validateGateway(gateway, settings!);
    const found = Object.entries(invalid).map(([field, message]) => ({
      field,
      label: field === "clientId" ? "Client ID" : "Webhook secret",
      message,
    }));
    if (found.length > 0) {
      fail(found);
      return;
    }
    setBusy("gateway");
    try {
      const next = await updateGatewaySettings(token, {
        clientId: gateway.clientId.trim(),
        // Absent, not null: an empty box means "leave the stored secret alone". It is
        // the only shape that works when the value cannot be read back.
        ...(gateway.webhookSecret.trim().length > 0
          ? { webhookSecret: gateway.webhookSecret.trim() }
          : {}),
      });
      setSettings(next);
      setGateway((current) => ({ ...current, webhookSecret: "" }));
      goTo("accounting");
    } catch (err) {
      fail([], messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Hand the browser to QuickBooks.
   *
   * A NAVIGATION, not a fetch. The next step is a human signing in at Intuit, and a
   * 302 from the server carries the state that ties the return to this attempt. The
   * credentials must already be saved: the server reads them when it builds the
   * authorization URL, and the client secret must never travel to the browser.
   */
  const startConnect = () => {
    window.location.assign('/api/v1/settings/adaptor/connect');
  };

  const submitAccounting = async () => {
    const invalid = validateAccounting(adaptorId, accounting, settings!);
    const choice = adaptorChoice(adaptorId);
    const found = Object.entries(invalid).map(([field, message]) => ({
      field,
      label:
        field === "id"
          ? "Accounting system"
          : (choice?.fields.find((f) => f.key === field)?.label ?? field),
      message,
    }));
    if (found.length > 0) {
      fail(found);
      return;
    }
    setBusy("accounting");
    try {
      const fields = Object.fromEntries(
        Object.entries(accounting).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
        ),
      );
      const next = await updateAdaptorSettings(token, {
        id: adaptorId,
        baseUrl: (accounting.baseUrl ?? "").trim() || null,
        credentials: fields,
        /*
          `realmId` is DELIBERATELY ABSENT. It is the company the provider named when
          the grant was made, and it is not a field on this form any more. Sending
          `null` would clear a company that is already connected every time somebody
          edited their client secret — the merge semantics on the server exist
          precisely so that an untouched field is left alone.
        */
      });
      setSettings(next);
      setVerification(null);
      setReturnFrom({ connected: false, realm: null, message: null });
      /*
        A system that authorizes in the browser STAYS on this step. Advancing to
        "test the connection" now would offer to test a connection that does not exist
        yet — the grant has not happened, and the operator has not even been sent
        anywhere. The stepper's own advance is what follows a successful return.
      */
      if (!choice?.browserConnect) {
        goTo('verify');
      }
    } catch (err) {
      fail([], messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const runVerification = async () => {
    setBusy("verify");
    clearErrors();
    setVerification(null);
    try {
      // No credentials in the body: this tests what step 3 just stored, which is the
      // configuration that will actually be used. Testing a transient copy would
      // prove the form, not the deployment.
      const result = await verifyAdaptor(token, {});
      setVerification(result);
    } catch (err) {
      setFailure(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const sendInvite = async () => {
    const invalid = validateInviteEmail(inviteEmail);
    if (invalid) {
      fail([{ field: "inviteEmail", label: "Email address", message: invalid }]);
      return;
    }
    const preset = INVITE_PRESETS.find((candidate) => candidate.id === invitePreset) ?? INVITE_PRESETS[0]!;
    setBusy("invite");
    try {
      const result = await inviteUser(token, {
        email: inviteEmail.trim(),
        // Derived from what this deployment serves, never typed: an invite naming an
        // organization no row belongs to creates a console that reads empty for the
        // person who just accepted it.
        organizationId: settings!.organizationId,
        policyAttributes: preset.attributesFor(settings!.organizationId),
      });
      setInvited((current) => [
        ...current,
        { email: result.invite.email, ...(result.token ? { link: `#/invite/${result.token}` } : {}) },
      ]);
      setInviteEmail("");
      clearErrors();
    } catch (err) {
      fail([], messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    setBusy("finish");
    try {
      await completeSettings(token);
      onDone();
    } catch (err) {
      fail([], messageOf(err));
      setBusy(null);
    }
  };

  /**
   * Skip setup, recording that this deployment is set up.
   *
   * WITHOUT THE STAMP the console would offer setup again on every sign-in, and an
   * operator whose deployment is configured entirely from its ENVIRONMENT — which is
   * a supported way to run one — would have to dismiss it forever. The deployment has
   * no way to know the environment was used, so the human decides and this records
   * the decision.
   *
   * Leaving is still the outcome when the stamp fails: an API that cannot record a
   * skip must not be able to keep somebody inside a setup they have finished.
   */
  const skipSetup = async () => {
    setBusy("finish");
    try {
      await completeSettings(token);
    } catch {
      // Deliberately swallowed — see above.
    }
    onDone();
  };

  /* ------------------------------------------------------------- rendering */

  if (loadError) {
    return (
      <Surface>
        <h1 className="m-0 text-xl font-semibold text-ink-1" tabIndex={-1}>
          Setup could not be loaded
        </h1>
        <p className="m-0 max-w-[62ch] text-md leading-prose text-ink-2">{loadError}</p>
        <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-3">
          Nothing has been changed. If this deployment has not finished setting up, its configuration
          endpoint may not be reachable yet.
        </p>
      </Surface>
    );
  }

  if (!settings) {
    return (
      <Surface>
        <p className="m-0 text-md text-ink-2" role="status">
          Loading this deployment's configuration…
        </p>
      </Surface>
    );
  }

  const choice = adaptorChoice(adaptorId);
  const reading = verification ? readingForVerification(verification) : null;
  const savedClientCredentials = Boolean(settings.adaptor.canAuthorize);

  return (
    <div className="min-h-dvh bg-midnight">
      <header className="border-b border-rule-enamel bg-midnight-2">
        <div className="mx-auto flex w-full max-w-[46rem] items-center gap-3 px-6 py-4 max-xs:px-4">
          <span
            className="grid size-8 flex-none place-items-center rounded-panel bg-midnight-3 text-primary"
            aria-hidden
          >
            <IconLedger size={18} />
          </span>
          <div className="min-w-0">
            <p className="mono m-0 text-micro uppercase tracking-label text-ink-3">First-run setup</p>
            <p className="m-0 truncate text-sm font-semibold text-ink-1">
              {settings.organizationName ?? "This deployment"}
            </p>
          </div>
          <button
            type="button"
            className={cx(LINK_BTN, "ml-auto")}
            onClick={() => void (settings.configured ? onLeave() : skipSetup())}
            disabled={busy !== null}
            {...(settings.configured
              ? {}
              : {
                  title:
                    "Records that this deployment is set up, so the console stops offering setup.",
                })}
          >
            {settings.configured ? "Close setup" : "Skip setup"}
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-6 py-8 max-xs:px-4">
        <Stepper
          steps={WIZARD_STEPS}
          current={stepId}
          furthestReachable={furthestReachable}
          onSelect={goTo}
        />

        {/* Said once, on the first step, and only while setup is unfinished: an
            operator whose deployment is configured from its environment needs to
            know that skipping is legitimate rather than a failure. */}
        {!settings.configured && stepId === "organization" && (
          <p className="m-0 max-w-[62ch] text-xs leading-prose text-ink-3">
            Already configured from this deployment's environment? <strong>Skip setup</strong> — that records setup as
            done, which is what stops the console offering it again.
          </p>
        )}

        <section className="flex flex-col gap-2">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="m-0 text-2xl font-semibold leading-tight text-ink-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {step.title}
          </h1>
          <p className="m-0 max-w-[62ch] text-md leading-prose text-ink-2">{step.lead}</p>
        </section>

        {!settings.writable && (
          <Notice tone="warn" title="This deployment cannot store credentials yet">
            No <code className="mono">SECRETS_KEY</code> is set, so the API will refuse every credential
            write. Generate one with{" "}
            <code className="mono">openssl rand -hex 32</code>, set it in the environment, and restart the
            API. You can look through the steps in the meantime — nothing you type will be saved.
          </Notice>
        )}

        {/* Focusable and announced: a failure has to be reachable without sight. */}
        <div ref={summaryRef} tabIndex={-1} className="focus-visible:outline-none">
          {errors.length > 0 && (
            <Notice tone="error" title="Check these before continuing">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {errors.map((error) => (
                  <li key={error.field}>
                    <a className="text-primary-ink underline" href={`#field-${error.field}`}>
                      {error.label}
                    </a>
                    {": "}
                    {error.message}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {errors.length === 0 && failure && (
            <Notice tone="error" title="That did not work">
              {failure}
            </Notice>
          )}
        </div>

        {stepId === "organization" && (
          <Fieldset>
            <AuthField
              id="field-organizationName"
              label="Deployment name"
              hint="Appears in the page header and the browser tab. Your team's name for this deployment."
              error={errors.find((e) => e.field === "organizationName")?.message ?? null}
            >
              <input
                id="field-organizationName"
                className={INPUT}
                value={organizationName}
                onChange={(event) => setOrganizationName(event.target.value)}
                autoComplete="organization"
                aria-invalid={errors.some((e) => e.field === "organizationName")}
              />
            </AuthField>

            <ReadOnlyRow
              label="Organization ID"
              value={settings.organizationId}
              explanation="Read-only: this is set when the deployment is provisioned, and every stored row and
                every access grant is filed under it. Changing it here would hide the records this
                deployment already has."
            />
          </Fieldset>
        )}

        {stepId === "gateway" && (
          <Fieldset>
            <AuthField
              id="field-clientId"
              label="Gateway client ID"
              error={errors.find((e) => e.field === "clientId")?.message ?? null}
            >
              <input
                id="field-clientId"
                className={INPUT}
                value={gateway.clientId}
                onChange={(event) => setGateway((c) => ({ ...c, clientId: event.target.value }))}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors.some((e) => e.field === "clientId")}
              />
            </AuthField>

            <SecretField
              id="field-webhookSecret"
              label="Webhook secret"
              hint={
                settings.gateway.webhookSecret.configured
                  ? `A secret is already stored (ends ${settings.gateway.webhookSecret.lastFour ?? "····"}). Leave this blank to keep it.`
                  : "The gateway signs every delivery with this. Without it this deployment refuses them."
              }
              error={errors.find((e) => e.field === "webhookSecret")?.message ?? null}
              value={gateway.webhookSecret}
              revealed={Boolean(revealed["webhookSecret"])}
              onToggleReveal={() =>
                setRevealed((c) => ({ ...c, webhookSecret: !c["webhookSecret"] }))
              }
              onChange={(value) => setGateway((c) => ({ ...c, webhookSecret: value }))}
            />
            <p className="m-0 max-w-[62ch] text-xs leading-prose text-ink-3">
              Secrets are stored encrypted and are never shown again — not on this screen, and not to any
              API client. This is the only time you can compare one.
            </p>
          </Fieldset>
        )}

        {stepId === "accounting" && (
          <Fieldset>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className={cx("p-0 text-ink-3", "mono text-micro uppercase tracking-label")}>
                Accounting system
              </legend>
              {ADAPTOR_CHOICES.map((option) => {
                const selected = adaptorId === option.id;
                return (
                  <label
                    key={option.id}
                    className={cx(
                      "flex cursor-pointer items-start gap-3 rounded-panel border p-3 transition-colors",
                      selected
                        ? "border-primary bg-primary-soft"
                        : "border-rule-enamel bg-midnight-2 hover:border-ink-4",
                    )}
                  >
                    <input
                      type="radio"
                      name="adaptor"
                      className="mt-1 accent-[var(--color-primary)]"
                      checked={selected}
                      onChange={() => {
                        setAdaptorId(option.id);
                        clearErrors();
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block text-md font-semibold text-ink-1">{option.label}</span>
                      <span className="block text-sm leading-prose text-ink-3">{option.blurb}</span>
                    </span>
                  </label>
                );
              })}
              {errors.find((e) => e.field === "id") && (
                <p className="m-0 text-xs text-text-suspended" role="alert">
                  {errors.find((e) => e.field === "id")!.message}
                </p>
              )}
            </fieldset>

            {choice && (
              <div className="flex flex-col gap-4 rounded-panel border border-rule-enamel-soft bg-midnight-2 p-4">
                <p className="m-0 text-sm leading-prose text-ink-3">
                  {settings.adaptor.id === choice.id && settings.adaptor.credentials.configured
                    ? `Credentials for ${choice.label} are already stored. Fill in only what you want to replace.`
                    : `Enter the ${choice.label} application credentials for this deployment.`}
                </p>
                {choice.fields.map((field) => {
                  const error = errors.find((e) => e.field === field.key)?.message ?? null;
                  if (field.secret) {
                    return (
                      <SecretField
                        key={field.key}
                        id={`field-${field.key}`}
                        label={field.label}
                        {...(field.hint ? { hint: field.hint } : {})}
                        error={error}
                        value={accounting[field.key] ?? ""}
                        revealed={Boolean(revealed[field.key])}
                        onToggleReveal={() =>
                          setRevealed((c) => ({ ...c, [field.key]: !c[field.key] }))
                        }
                        onChange={(value) => setAccounting((c) => ({ ...c, [field.key]: value }))}
                      />
                    );
                  }
                  return (
                    <AuthField
                      key={field.key}
                      id={`field-${field.key}`}
                      label={field.optional ? `${field.label} (optional)` : field.label}
                      {...(field.hint ? { hint: field.hint } : {})}
                      error={error}
                    >
                      <input
                        id={`field-${field.key}`}
                        className={INPUT}
                        value={accounting[field.key] ?? ""}
                        onChange={(event) =>
                          setAccounting((c) => ({ ...c, [field.key]: event.target.value }))
                        }
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={Boolean(error)}
                      />
                    </AuthField>
                  );
                })}

                {/*
                  THE CONNECT STEP, which replaces a token field.

                  The button is a NAVIGATION and only appears once the application
                  credentials are SAVED, because the server reads the stored client
                  secret when it builds the authorization URL — and that secret must
                  never be sent to a browser to do it. Offering the button first
                  would produce a 400 whose cause is invisible from this screen.
                */}
                {choice.browserConnect && (
                  <div className="flex flex-col gap-2 border-t border-rule-enamel-soft pt-4">
                    {savedClientCredentials ? (
                      <>
                        <p className="m-0 text-sm leading-prose text-ink-2">
                          Next, sign in at QuickBooks and approve this application. You are sent to
                          Intuit, and the connection comes back here when you are done.
                        </p>
                        <div>
                          <button type="button" className={BTN_PRIMARY} onClick={startConnect}>
                            Connect to QuickBooks
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="m-0 text-sm leading-prose text-ink-3">
                        Save these credentials first. Connecting reads the client secret on the server,
                        so it is never sent to this browser.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* The provider's answer, on arrival. Announced, because the person
                navigated away to a login page and deserves to be told what happened
                without hunting for it. */}
            {returnFrom.message && (
              <p
                className="m-0 max-w-[62ch] text-sm leading-prose text-text-suspended"
                role="status"
              >
                {returnFrom.message}
              </p>
            )}
          </Fieldset>
        )}

        {stepId === "verify" && (
          <Fieldset>
            {returnFrom.connected && (
              <div className="rounded-panel border border-line-green bg-midnight-2 p-4">
                <p className="m-0 text-md font-semibold text-line-green" role="status">
                  Authorized
                </p>
                <p className="m-0 mt-1 max-w-[62ch] text-sm leading-prose text-ink-2">
                  {returnFrom.realm
                    ? `This deployment is authorized to post into company ${returnFrom.realm}. Check that it is the company you meant — a grant is given by whichever account signed in.`
                    : 'This deployment is authorized. Check the company below before posting anything to it.'}
                </p>
              </div>
            )}

            <p className="m-0 max-w-[62ch] text-sm leading-prose text-ink-2">
              This is one real request to {choice?.label ?? "the accounting system"}, using the credentials
              stored in the previous step. A failed test is recorded nowhere — it raises no event and no
              finding, because a credential being corrected is not an outage.
            </p>

            {settings.verifiedAt && !verification && (
              <p className="mono m-0 text-xs text-ink-3">
                Last verified {formatDateTime(settings.verifiedAt)}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={BTN_PRIMARY}
                onClick={runVerification}
                disabled={busy !== null}
              >
                {busy === "verify" ? "Testing…" : verification ? "Test again" : "Test connection"}
              </button>
              {settings.adaptor.id && !settings.adaptor.credentials.configured && (
                <span className="text-sm text-ink-3">No credentials are stored yet — go back a step.</span>
              )}
            </div>

            {/* Announced politely so the wait is not silent, and replaced by the
                verdict so the two never both claim the same live region. */}
            <p className="sr-only" role="status" aria-live="polite">
              {busy === "verify" ? "Testing the connection to the accounting system." : ""}
            </p>

            {reading && (
              <div
                className={cx(
                  "rounded-panel border p-4",
                  reading.ok ? "border-line-green bg-midnight-2" : "border-text-suspended bg-midnight-2",
                )}
              >
                <p
                  className={cx(
                    "m-0 text-md font-semibold",
                    reading.ok ? "text-line-green" : "text-text-suspended",
                  )}
                  role="status"
                >
                  {reading.headline}
                </p>
                <p className="m-0 mt-1 max-w-[62ch] text-sm leading-prose text-ink-2">{reading.detail}</p>
              </div>
            )}
          </Fieldset>
        )}

        {stepId === "people" && (
          <Fieldset>
            <AuthField
              id="field-inviteEmail"
              label="Email address"
              hint="They receive a link and choose their own password. Access expires if it is not accepted."
              error={errors.find((e) => e.field === "inviteEmail")?.message ?? null}
            >
              <input
                id="field-inviteEmail"
                className={INPUT}
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors.some((e) => e.field === "inviteEmail")}
              />
            </AuthField>

            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className={cx("p-0 text-ink-3", "mono text-micro uppercase tracking-label")}>
                Access to grant
              </legend>
              {INVITE_PRESETS.map((preset) => (
                <label key={preset.id} className="flex cursor-pointer items-start gap-3">
                  <input
                    type="radio"
                    name="invite-preset"
                    className="mt-1 accent-[var(--color-primary)]"
                    checked={invitePreset === preset.id}
                    onChange={() => setInvitePreset(preset.id)}
                  />
                  <span className="min-w-0">
                    <span className="block text-md text-ink-1">{preset.label}</span>
                    <span className="block text-sm leading-prose text-ink-3">{preset.blurb}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div>
              <button type="button" className={BTN} onClick={sendInvite} disabled={busy !== null}>
                {busy === "invite" ? "Sending…" : "Send invitation"}
              </button>
            </div>

            {invited.length > 0 && (
              <div className="rounded-panel border border-rule-enamel-soft bg-midnight-2 p-4">
                <p className="mono m-0 text-micro uppercase tracking-label text-ink-3">
                  Invited in this session
                </p>
                <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                  {invited.map((entry) => (
                    <li key={entry.email} className="text-sm text-ink-1">
                      {entry.email}
                      {entry.link && (
                        <>
                          {" "}
                          <a className="text-primary-ink underline" href={entry.link}>
                            accept link
                          </a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="m-0 max-w-[62ch] text-xs leading-prose text-ink-3">
              Inviting anyone is optional — you can add people later from Users. Finishing setup records
              that this deployment is configured and opens the console.
            </p>
          </Fieldset>
        )}

        <footer className="flex flex-wrap items-center gap-3 border-t border-rule-enamel pt-5">
          {stepIndex(stepId) > 0 && (
            <button
              type="button"
              className={BTN}
              onClick={() => goTo(WIZARD_STEPS[stepIndex(stepId) - 1]!.id)}
              disabled={busy !== null}
            >
              Back
            </button>
          )}

          {stepId === "organization" && (
            <button type="button" className={BTN_PRIMARY} onClick={submitOrganization} disabled={busy !== null}>
              {busy === "name" ? "Saving…" : "Save and continue"}
            </button>
          )}
          {stepId === "gateway" && (
            <button type="button" className={BTN_PRIMARY} onClick={submitGateway} disabled={busy !== null}>
              {busy === "gateway" ? "Saving…" : "Save and continue"}
            </button>
          )}
          {stepId === "accounting" && (
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={submitAccounting}
              disabled={busy !== null}
            >
              {busy === "accounting" ? "Saving…" : "Save and continue"}
            </button>
          )}
          {stepId === "verify" && verification?.ok && (
            <button type="button" className={BTN_PRIMARY} onClick={() => goTo("people")} disabled={busy !== null}>
              Continue
            </button>
          )}
          {stepId === "verify" && verification && !verification.ok && (
            <button type="button" className={BTN} onClick={() => goTo("people")} disabled={busy !== null}>
              Continue unverified
            </button>
          )}
          {stepId === "verify" && !verification && settings.verifiedAt && (
            <button type="button" className={BTN} onClick={() => goTo("people")} disabled={busy !== null}>
              Continue
            </button>
          )}
          {stepId === "people" && (
            <button type="button" className={BTN_PRIMARY} onClick={finish} disabled={busy !== null}>
              {busy === "finish" ? "Finishing…" : "Finish setup"}
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------ presentation */

function Surface({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-midnight px-6">
      <div className="flex w-full max-w-[38rem] flex-col gap-3">{children}</div>
    </div>
  );
}

function Fieldset({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn" | "error";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-panel border p-4",
        tone === "error" ? "border-text-suspended bg-midnight-2" : "border-state-delayed bg-midnight-2",
      )}
      {...(tone === "error" ? { role: "alert" } : {})}
    >
      <p
        className={cx(
          "m-0 text-md font-semibold",
          tone === "error" ? "text-text-suspended" : "text-state-delayed",
        )}
      >
        {title}
      </p>
      <div className="m-0 mt-1 text-sm leading-prose text-ink-2">{children}</div>
    </div>
  );
}

/**
 * A value shown but not editable.
 *
 * Styled as text rather than as a disabled input: an input that looks editable and
 * is not is worse than no field at all, because the first thing anyone does is try
 * to click it.
 */
function ReadOnlyRow({
  label,
  value,
  explanation,
}: {
  label: string;
  value: string;
  explanation: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-panel border border-rule-enamel-soft bg-midnight-2 p-3">
      <span className={cx("text-ink-3", "mono text-micro uppercase tracking-label")}>{label}</span>
      <code className="mono text-md text-ink-1">{value}</code>
      <p className="m-0 max-w-[62ch] text-xs leading-prose text-ink-3">{explanation}</p>
    </div>
  );
}

/**
 * A secret field with a reveal control.
 *
 * Password managers are not fought: nothing blocks paste, nothing clears the field
 * on focus, and there is no read-only-until-clicked trick. `autoComplete="off"`
 * only declines to invite a manager to save a value that is not a credential for
 * this site — and the reveal toggle exists because these are long random strings
 * that people paste, and a paste is worth verifying.
 */
function SecretField({
  id,
  label,
  hint,
  error,
  value,
  revealed,
  onToggleReveal,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  value: string;
  revealed: boolean;
  onToggleReveal: () => void;
  onChange: (value: string) => void;
}) {
  return (
    <AuthField
      id={id}
      label={label}
      {...(hint ? { hint } : {})}
      error={error ?? null}
    >
      <span className="flex items-center gap-2">
        <input
          id={id}
          className={INPUT}
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
        />
        <button
          type="button"
          className={cx(BTN, "flex-none")}
          onClick={onToggleReveal}
          aria-pressed={revealed}
        >
          {revealed ? "Hide" : "Show"}
        </button>
      </span>
    </AuthField>
  );
}
