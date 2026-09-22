import { Fragment, useMemo } from "react";
import {
  constructSortFn,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { EVENT_LABEL } from "@/types/domain";
import type { EventType, Failure, LifecycleEvent } from "@/types/domain";
import { cx } from "./ui";

/* ------------------------------------------------------------------ */
/* TanStack Table wiring. Shared, stable feature set.                  */
/* ------------------------------------------------------------------ */

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

/* Clock times written "HH:MM:SS" (or "HH:MM"), compared as seconds since
   midnight. Also handles full ISO timestamps (contains a date separator) by
   parsing with Date, so sorting is correct for both display formats (M1). */
const toSeconds = (t: string) => {
  const value = String(t ?? "");
  if (value.includes("T") || value.includes("-")) {
    const ms = new Date(value).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  const [h, m, s] = (value || "00:00:00").split(":").map(Number);
  return ((h || 0) * 60 + (m || 0)) * 60 + (s || 0);
};

const sortClock = constructSortFn({
  sort: (a, b) => toSeconds(String(a ?? "")) - toSeconds(String(b ?? "")),
});

/* Event stream type order: newest lifecycle phase first. */
const EVENT_ORDER: Record<EventType, number> = {
  "webhook-received": 0,
  collected: 1,
  "record-updated": 2,
  "sync-change": 3,
  initiated: 4,
  "payment-declined": 5,
  "payment-failed": 6,
};
const sortEventType = constructSortFn({
  sort: (a, b) =>
    (EVENT_ORDER[String(a) as EventType] ?? 9) -
    (EVENT_ORDER[String(b) as EventType] ?? 9),
});

/* Failure severity: critical floats up on ascending. */
const sortSeverity = constructSortFn({
  sort: (a, b) => (a === "critical" ? 0 : 1) - (b === "critical" ? 0 : 1),
});

/* ------------------------------------------------------------------ */
/* Shared header cell: rules the column with a native sort button.     */
/* ------------------------------------------------------------------ */

const SORT_GLYPH: Record<"asc" | "desc", string> = {
  asc: "M8 11 L4.5 6 M8 11 L11.5 6",
  desc: "M8 5 L4.5 10 M8 5 L11.5 10",
};
const SORT_GLYPH_HINT = "M8 8 L5 6.2 M8 8 L11 6.2 M8 8 L5 9.8 M8 8 L11 9.8";
/* Glyph geometry, shared by both states. */
const SORT_GLYPH_BASE =
  "size-3 flex-none fill-none stroke-current [stroke-width:1.5] [stroke-linecap:round] [stroke-linejoin:round]";

function SortGlyph({ dir }: { dir: false | "asc" | "desc" }) {
  const d = dir === false ? SORT_GLYPH_HINT : SORT_GLYPH[dir];
  /* The unsorted "hint" glyph is the faint ink; the sorted glyph inherits the
     header's own ink. */
  const cls = dir === false ? `${SORT_GLYPH_BASE} text-ink-3` : SORT_GLYPH_BASE;
  return (
    <svg className={cls} width={12} height={12} viewBox="0 0 16 16" role="img" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Lifecycle event stream (FR-5.1).                                    */
/* ------------------------------------------------------------------ */

const EVENT_HEAD_LABEL: Record<string, string> = {
  at: "Time",
  type: "Event",
  ref: "Ref",
  channel: "Channel",
  detail: "Detail",
};

function buildEventColumns(): ColumnDef<any, LifecycleEvent, unknown>[] {
  return [
    {
      id: "at",
      accessorKey: "at",
      header: "Time",
      sortFn: sortClock,
      cell: (info) => (
        <span className="mono text-sm whitespace-nowrap text-ink-3">{String(info.getValue())}</span>
      ),
    },
    {
      id: "type",
      accessorKey: "type",
      header: "Event",
      sortFn: sortEventType,
      cell: (info) => (
        <span className="inline-flex items-center gap-2 text-sm font-semibold whitespace-nowrap text-ink-1">
          <span className="size-2 rounded-[1px] bg-primary" aria-hidden />
          {EVENT_LABEL[String(info.getValue()) as EventType] ?? "Event"}
        </span>
      ),
    },
    {
      id: "ref",
      accessorKey: "ref",
      header: "Ref",
      sortFn: sortFn_alphanumeric,
      cell: (info) => (
        <span className="mono text-sm font-semibold whitespace-nowrap text-ink-1 max-3xl:hidden">
          {String(info.getValue())}
        </span>
      ),
    },
    {
      id: "channel",
      accessorKey: "channel",
      header: "Channel",
      sortFn: sortFn_text,
      cell: (info) => (
        <span className="text-sm whitespace-nowrap text-ink-2 max-3xl:hidden">{String(info.getValue())}</span>
      ),
    },
    {
      id: "detail",
      accessorKey: "detail",
      header: "Detail",
      sortFn: sortFn_text,
      cell: (info) => (
        <span className="text-sm text-ink-2 max-md:hidden">{String(info.getValue())}</span>
      ),
    },
  ];
}

/* Every column head shares one treatment: the uppercase micro-label in mono. */
const EVENT_HEAD_LABEL_CLASS = "font-mono text-xs tracking-label uppercase text-ink-2";
const EVENT_HEAD_CLASS: Record<string, string> = {
  at: EVENT_HEAD_LABEL_CLASS,
  type: EVENT_HEAD_LABEL_CLASS,
  ref: EVENT_HEAD_LABEL_CLASS,
  channel: EVENT_HEAD_LABEL_CLASS,
  detail: EVENT_HEAD_LABEL_CLASS,
};

export function EventStream({ events }: { events: LifecycleEvent[] }) {
  const columns = useMemo(() => buildEventColumns(), []);
  const table = useTable({
    key: "events",
    features,
    columns,
    data: events,
    getRowId: (e) => e.id,
  });
  const headerGroups = table.getHeaderGroups();
  const headers = headerGroups.length > 0 ? headerGroups[0].headers : [];

  return (
    <div role="table" aria-label="Lifecycle event stream">
      <div
        className="grid grid-cols-[86px_132px_minmax(84px,0.8fr)_minmax(120px,1.2fr)_minmax(0,2.2fr)] gap-x-3 border-b border-ink-2 bg-midnight-3 px-3 py-2 max-3xl:hidden"
        role="row"
      >
        {headers.map((header) => {
          const colId = header.column.columnDef.id ?? "";
          const dir = header.column.getIsSorted();
          const canSort = header.column.getCanSort();
          const label = EVENT_HEAD_LABEL[colId] ?? "";
          return (
            <span
              key={header.id}
              role="columnheader"
              className={EVENT_HEAD_CLASS[colId] ?? ""}
              aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}
            >
              {canSort ? (
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-2 p-0 text-inherit hover:text-ink-1"
                  onClick={header.column.getToggleSortingHandler()}
                  aria-label={label ? `Sort ${label}` : undefined}
                >
                  {label}
                  <SortGlyph dir={dir} />
                </button>
              ) : label}
            </span>
          );
        })}
      </div>
      {table.getRowModel().rows.map((row) => (
        <div
          key={row.id}
          className="grid grid-cols-[86px_132px_minmax(84px,0.8fr)_minmax(120px,1.2fr)_minmax(0,2.2fr)] items-center gap-x-3 border-b border-rule-enamel bg-midnight-2 px-3 py-2 transition-colors hover:bg-midnight-3 max-3xl:grid-cols-[74px_1fr_minmax(120px,1.4fr)] max-md:grid-cols-[74px_1fr]"
          role="row"
        >
          {row.getAllCells().map((cell) => (
            <Fragment key={cell.id}>{table.FlexRender({ cell })}</Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Active failures / findings (FR-5.3).                                */
/* ------------------------------------------------------------------ */

/* Severity → its lamp and its ink. The old sheet expressed these as
   `.finding-lamp--critical` / `.finding-sev--attention` selector pairs; a
   lookup keeps the two in step. */
const SEVERITY_LAMP: Record<string, string> = {
  critical: "bg-state-suspended shadow-[0_0_0_1px_var(--color-state-suspended)]",
  attention: "bg-state-delayed shadow-[0_0_0_1px_var(--color-state-delayed)]",
};
const SEVERITY_INK: Record<string, string> = {
  critical: "text-text-suspended",
  attention: "text-state-delayed",
};

const SEVERITY_CELL = "inline-flex items-center gap-2 whitespace-nowrap";
const SEVERITY_LAMP_GEOMETRY = "size-[9px] flex-none rounded-[1px]";
const SEVERITY_INK_GEOMETRY = "font-mono text-xs tracking-label uppercase";

/* The acknowledge action: brand amber with the accessible on-amber ink, and
   the quiet slate treatment when the action is unavailable. */
const FINDING_BTN = "rounded-panel px-2 py-1 text-xs font-semibold";
const FINDING_BTN_ACK =
  `${FINDING_BTN} cursor-pointer border border-primary bg-primary text-on-primary hover:not-disabled:bg-primary-hover disabled:cursor-not-allowed disabled:border-rule-enamel disabled:bg-midnight-3 disabled:text-ink-3`;
const FINDING_BTN_DETAIL =
  `${FINDING_BTN} cursor-pointer border border-rule-enamel bg-transparent text-state-arriving hover:bg-midnight-3`;

function buildFindingsColumns(
  canAck: boolean,
  onAck: (id: string) => void,
): ColumnDef<any, Failure, unknown>[] {
  return [
    {
      id: "severity",
      accessorKey: "severity",
      header: "Severity",
      sortFn: sortSeverity,
      cell: (info) => {
        const s = String(info.getValue());
        return (
          <span className={SEVERITY_CELL}>
            <span className={cx(SEVERITY_LAMP_GEOMETRY, SEVERITY_LAMP[s] ?? "")} aria-hidden />
            <span className={cx(SEVERITY_INK_GEOMETRY, SEVERITY_INK[s] ?? "text-ink-3")}>{s}</span>
          </span>
        );
      },
    },
    {
      id: "id",
      accessorKey: "id",
      header: "Finding",
      sortFn: sortFn_alphanumeric,
      cell: (info) => (
        <span className="mono text-sm font-semibold whitespace-nowrap text-ink-1">
          {String(info.getValue())}
        </span>
      ),
    },
    {
      id: "channel",
      accessorKey: "channel",
      header: "Channel",
      sortFn: sortFn_text,
      cell: (info) => (
        <span className="text-xs whitespace-nowrap text-ink-2">{String(info.getValue())}</span>
      ),
    },
    {
      id: "issue",
      accessorKey: "title",
      header: "Issue",
      sortFn: sortFn_text,
      cell: (info) => (
        <span className="flex flex-col items-start gap-1">
          <span className="text-md font-semibold leading-[1.3] text-ink-1">{String(info.getValue())}</span>
          <span className="max-w-[46ch] text-xs leading-snug text-ink-2">{info.row.original.detail}</span>
        </span>
      ),
    },
    {
      id: "since",
      accessorKey: "since",
      header: "Since",
      sortFn: sortClock,
      cell: (info) => (
        <span className="mono text-xs whitespace-nowrap text-ink-3">{String(info.getValue())}</span>
      ),
    },
    {
      id: "action",
      header: "",
      enableSorting: false,
      cell: (info) => {
        const id = info.row.original.id;
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <button className={FINDING_BTN_ACK} disabled={!canAck} onClick={() => onAck(id)}>
              Acknowledge
            </button>
            <button className={FINDING_BTN_DETAIL}>Open detail</button>
          </span>
        );
      },
    },
  ];
}

export function FindingsTable({
  findings,
  canAck,
  onAck,
}: {
  findings: Failure[];
  canAck: boolean;
  onAck: (id: string) => void;
}) {
  const columns = useMemo(() => buildFindingsColumns(canAck, onAck), [canAck, onAck]);
  const table = useTable({
    key: "findings",
    features,
    columns,
    data: findings,
    getRowId: (f) => f.id,
  });
  const headerGroups = table.getHeaderGroups();
  const headers = headerGroups.length > 0 ? headerGroups[0].headers : [];
  const headerById = new Map(headers.map((h) => [h.column.columnDef.id, h]));

  const sortCell = (id: string, label: string) => {
    const header = headerById.get(id);
    if (!header) return null;
    const dir = header.column.getIsSorted();
    return (
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-2 p-0 text-inherit hover:text-ink-1"
        onClick={header.column.getToggleSortingHandler()}
        aria-label={`Sort ${label}`}
      >
        {label}
        <SortGlyph dir={dir} />
      </button>
    );
  };

  return (
    <div className="mt-3 flex flex-col gap-3" role="list" aria-label="Active failures">
      <div
        className="flex justify-between border-b border-ink-2 pb-1.5 [&_span]:font-mono [&_span]:text-xs [&_span]:tracking-label [&_span]:uppercase [&_span]:text-ink-1 [&_span:hover]:text-ink-2"
        aria-hidden
      >
        <span>{sortCell("severity", "Severity")}</span>
        <span>{sortCell("since", "Since")}</span>
      </div>
      {table.getRowModel().rows.length === 0 ? (
        <div className="rounded-panel border border-dashed border-rule-enamel bg-midnight-2 px-4 py-6 text-left">
          <h3 className="text-ink-1">All clear</h3>
          <p className="mt-1.5 text-md text-ink-2">No open findings. Every connector is open and the sync loop is healthy.</p>
        </div>
      ) : (
        table.getRowModel().rows.map((row) => {
          const f = row.original;
          return (
            <div
              key={row.id}
              className="flex flex-col gap-2 border-b border-l border-rule-enamel bg-midnight-2 p-3 data-[severity=critical]:border-l-state-suspended data-[severity=attention]:border-l-state-delayed"
              role="listitem"
              data-severity={f.severity}
            >
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                <span className={SEVERITY_CELL}>
                  <span className={cx(SEVERITY_LAMP_GEOMETRY, SEVERITY_LAMP[f.severity] ?? "")} aria-hidden />
                  <span className={cx(SEVERITY_INK_GEOMETRY, SEVERITY_INK[f.severity] ?? "text-ink-3")}>
                    {f.severity}
                  </span>
                </span>
                <span className="mono text-sm font-semibold whitespace-nowrap text-ink-1">{f.id}</span>
                <span className="text-xs whitespace-nowrap text-ink-2">{f.channel}</span>
                <span className="mono text-xs whitespace-nowrap text-ink-3">{f.since}</span>
              </div>
              <div className="flex flex-col items-start gap-1">
                <span className="text-md font-semibold leading-[1.3] text-ink-1">{f.title}</span>
                <span className="max-w-[46ch] text-xs leading-snug text-ink-2">{f.detail}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button className={FINDING_BTN_ACK} disabled={!canAck} onClick={() => onAck(f.id)}>
                  Acknowledge
                </button>
                <button className={FINDING_BTN_DETAIL}>Open detail</button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
