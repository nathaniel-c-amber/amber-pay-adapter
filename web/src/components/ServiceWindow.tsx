/**
 * ServiceWindow — a window into the backend process itself.
 *
 * The console reports on payment flow, but a console that cannot report on its
 * own data source has a blind spot it never admits to: "all healthy" and "the
 * service stopped answering two hours ago" looked identical, because the last
 * good snapshot was simply re-rendered.
 *
 * This panel closes that hole. It states what the backend is (build, uptime,
 * storage), what it is watching (event window, row counts, adaptor
 * reachability), and therefore what the console can and cannot see. When the
 * service is unreachable the shell renders the degraded variant, so silence
 * is labelled as silence.
 */

import type { ApiServiceStatus } from "@/types/api";
import { formatDuration } from "@/utils/flow";
import {
  IconAdaptor,
  IconService,
  IconStorage,
  IconUptime,
} from "./icons";
import { cx } from "./ui";

/* The panel shell. The border COLOUR is chosen per state below rather than
   sitting in the shell, so it never competes with the blind variant. */
const SERVICE = "rounded-panel border bg-midnight-2 px-5 py-4 shadow-panel";

function uptimeLabel(startedAt: string, now: Date): string {
  const t = new Date(startedAt).getTime();
  if (Number.isNaN(t)) return "—";
  return formatDuration(Math.max(0, now.getTime() - t));
}

/** Reachability reads as a sentence, not a colour: "reachable · 42ms". */
function adaptorLabel(a: ApiServiceStatus["service"]["adaptors"][number]): string {
  if (!a.reachable) return a.message?.trim() || "unreachable";
  return a.latencyMs === null ? "reachable" : `reachable · ${a.latencyMs}ms`;
}

export function ServiceWindow({
  service,
  now,
  unavailable,
}: {
  service: ApiServiceStatus | null;
  now: Date;
  /** True when the last live fetch failed — the window must say so. */
  unavailable: boolean;
}) {
  if (!service) {
    return (
      <section
        className={cx(
          SERVICE,
          unavailable ? "border-[rgb(248_113_113/0.34)]" : "border-rule-enamel",
        )}
        aria-label="Backend service"
      >
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule-enamel-soft pb-3">
          <span className="inline-flex items-center gap-2 text-lg font-semibold text-ink-1">
            <IconService size={16} />
            Backend service
          </span>
          <span
            className={cx(
              "mono text-xs tracking-label uppercase",
              unavailable ? "text-text-suspended" : "text-ink-3",
            )}
          >
            {unavailable ? "not responding" : "no status"}
          </span>
        </header>
        <p className="mt-3 max-w-[76ch] text-md text-ink-2">
          {unavailable
            ? "The service is not answering status requests. Everything above is the last data the console received, not a current reading — treat the flow numbers as frozen, not healthy."
            : "The console has no service status yet. Flow numbers below come from the last successful refresh."}
        </p>
      </section>
    );
  }

  const s = service.service;
  const unreachable = s.adaptors.filter((a) => !a.reachable);

  return (
    <section className="rounded-panel border border-rule-enamel bg-midnight-2 px-5 py-4 shadow-panel" aria-label="Backend service">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule-enamel-soft pb-3">
        <span className="inline-flex items-center gap-2 text-lg font-semibold text-ink-1">
          <IconService size={16} />
          Backend service
        </span>
        <span className="mono text-xs tracking-label uppercase text-ink-3">
          {s.name} v{s.version} · {s.environment}
        </span>
      </header>

      <dl className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(148px,1fr))] gap-x-6 gap-y-3 [&_dt]:flex [&_dt]:items-center [&_dt]:gap-1.5 [&_dt]:text-micro [&_dt]:uppercase [&_dt]:tracking-label [&_dt]:text-ink-3 [&_dd]:mt-1 [&_dd]:text-md [&_dd]:text-ink-1">
        <div>
          <dt>
            <IconUptime size={14} />
            Uptime
          </dt>
          <dd className="mono">{uptimeLabel(s.startedAt, now)}</dd>
        </div>
        <div>
          <dt>
            <IconStorage size={14} />
            Storage
          </dt>
          <dd className="mono">{s.storage}</dd>
        </div>
        <div>
          <dt>Event window</dt>
          <dd className="mono">{s.eventWindowLimit.toLocaleString()} events</dd>
        </div>
        <div>
          <dt>Rows</dt>
          <dd className="mono">
            {s.rows.connectors === null ? "—" : `${s.rows.connectors} connectors`}
            {" · "}
            {s.rows.failures === null ? "—" : `${s.rows.failures} findings`}
          </dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd className="mono">{s.nodeVersion}</dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-rule-enamel-soft pt-3">
        <div className="flex items-center gap-2 text-micro tracking-label uppercase text-ink-3">
          <IconAdaptor size={14} />
          Accounting adaptors
          {unreachable.length > 0 && (
            <span className="text-text-suspended normal-case tracking-[0]">
              {" "}
              · {unreachable.length} unreachable
            </span>
          )}
        </div>
        {s.adaptors.length === 0 ? (
          <p className="mt-2 text-sm text-ink-3">No adaptors are registered on this instance.</p>
        ) : (
          <ul className="mt-2 flex list-none flex-wrap gap-2 p-0">
            {s.adaptors.map((a) => (
              <li
                key={a.id}
                className={cx(
                  "inline-flex items-baseline gap-2 rounded-chip border bg-midnight-3 px-3 py-1",
                  a.reachable ? "border-rule-enamel" : "border-[rgb(248_113_113/0.34)]",
                )}
              >
                <span className="text-sm text-ink-1">{a.name}</span>
                <span className={cx("mono text-xs", a.reachable ? "text-line-green" : "text-text-suspended")}>
                  {adaptorLabel(a)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
