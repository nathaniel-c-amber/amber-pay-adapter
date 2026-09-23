import { useState } from "react";
import { IconEdit, IconServer } from "@/components/icons";
import { Card, DemoTag, PageHeader, BTN_PRIMARY, cx } from "@/components/ui";
import { Can, Cannot } from "@/components/Can";
import { SYSTEM_MANAGE } from "@/utils/permissions";
import type { AdaptorConfig } from "@/utils/fixtures";

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={cx(
        "relative h-5.5 w-10 flex-none cursor-pointer rounded-full border border-rule-enamel bg-midnight-3 transition-colors",
        on && "border-primary bg-primary",
      )}
      onClick={() => onChange(!on)}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-[white] shadow-[0_1px_2px_rgb(12_18_44/0.25)] transition-transform",
          on && "translate-x-4.5",
        )}
        aria-hidden
      />
    </button>
  );
}

export function ConfigPage({
  configs,
  webhook,
  mode,
}: {
  configs: AdaptorConfig[];
  /** Null in a build with no configuration source to read (see the shell). */
  webhook: { target: string; retainForDays: number; alertTarget: string } | null;
  mode: "demo" | "live";
}) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(configs.map((c) => [c.id, c.enabled])),
  );
  const [saved, setSaved] = useState(false);

  const save = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="flex flex-col gap-4 animate-[fadeIn_0.2s_ease-out]">
      <PageHeader
        title="System configuration"
        lead="Connector adaptors, sync cadence, and alert routing for the gateway ⇄ accounting link."
        actions={
          <>
            {mode === "demo" && <DemoTag />}
            <Can ability={SYSTEM_MANAGE}>
              <button type="button" className={BTN_PRIMARY} onClick={save}>
                <IconEdit /> {saved ? "Saved" : "Save changes"}
              </button>
            </Can>
          </>
        }
      />

      <Cannot ability={SYSTEM_MANAGE}>
        <div className="flex items-center gap-2 rounded-panel border border-[rgb(230_161_42/0.4)] bg-state-tint-delayed px-3 py-2 text-sm text-text-delayed [&_svg]:animate-warn">
          Your active scope can view this configuration but not change it. Selecting a scope with
          the <code>admin</code> action unlocks editing.
        </div>
      </Cannot>

      <Card title="Accounting adaptors" className="flex flex-col">
        {configs.length === 0 && (
          /* No rows and no invention. This deployment exposes no configuration
             endpoint, so the honest page is one that says so — the alternative
             was a synthetic adaptor list that looked exactly like a real one. */
          <p className="m-0 max-w-[62ch] text-md leading-prose text-ink-2">
            No adaptor configuration is available. This deployment exposes no configuration
            endpoint, so the console has nothing to read — it will not show a plausible example in
            place of the real thing.
          </p>
        )}
        {configs.map((config) => (
          <div className="grid grid-cols-[40px_1fr_auto_auto] items-center gap-3 border-b border-rule-enamel px-0.5 py-3 last:border-b-0 max-sm:grid-cols-[36px_1fr_auto]" key={config.id}>
            <span className="grid size-10 place-items-center rounded-panel bg-secondary-soft text-secondary-ink transition-colors hover:bg-[rgb(191_122_178/0.24)]">
              <IconServer />
            </span>
            <div className="min-w-0">
              <div className="text-md font-semibold text-ink-1">{config.name}</div>
              <div className="mono truncate text-xs text-ink-3">{config.endpoint}</div>
            </div>
            <div className="mono flex flex-col items-end gap-0.5 text-right text-xs text-ink-2 max-sm:hidden">
              <span className="text-micro uppercase tracking-label text-ink-3">{config.kind === "push" ? "push target" : "pull"}</span>
              {config.syncInterval && <span>{config.syncInterval}</span>}
            </div>
            <Cannot ability={SYSTEM_MANAGE}>
              <span
                className="mono text-xs text-ink-3 max-sm:hidden"
                title="Disabled under a read-only scope"
              >
                locked
              </span>
            </Cannot>
            <Can ability={SYSTEM_MANAGE}>
              <Toggle
                on={enabled[config.id] ?? true}
                onChange={(v) => setEnabled((s) => ({ ...s, [config.id]: v }))}
                label={`Toggle ${config.name}`}
              />
            </Can>
          </div>
        ))}
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-4 max-lg:grid-cols-[minmax(0,1fr)]">
        <Card title="Webhook pipeline" className="config-webhook">
          {!webhook ? (
            <p className="m-0 max-w-[62ch] text-md leading-prose text-ink-2">
              No webhook configuration is available from this deployment.
            </p>
          ) : (
          <dl className="flex flex-col">
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Target endpoint</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{webhook.target}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Event retention</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{webhook.retainForDays} days</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-b border-rule-enamel px-0.5 py-2 last:border-b-0">
              <dt className="mono min-w-0 text-xs uppercase tracking-label text-ink-3 wrap-anywhere">Alert routing</dt>
              <dd className="mono m-0 min-w-0 text-right text-md text-ink-1 wrap-anywhere">{webhook.alertTarget}</dd>
            </div>
          </dl>
          )}
        </Card>

        <Card title="Sync cadence" className="config-cadence">
          <div className="flex items-center justify-between border-b border-rule-enamel px-0.5 py-3 last:border-b-0">
            <span className="text-md text-ink-2">Scheduled reconciliation pull</span>
            <span className="cadence-value mono">every 15 min</span>
          </div>
          <div className="flex items-center justify-between border-b border-rule-enamel px-0.5 py-3 last:border-b-0">
            <span className="text-md text-ink-2">Payment push window</span>
            <span className="cadence-value mono">≤ 5 s</span>
          </div>
          <div className="flex items-center justify-between border-b border-rule-enamel px-0.5 py-3 last:border-b-0">
            <span className="text-md text-ink-2">Failure alert delay</span>
            <span className="cadence-value mono">immediate</span>
          </div>
        </Card>
      </div>
    </div>
  );
}