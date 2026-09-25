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
import { Can } from "./Can";
import { IconSortAsc, IconSortAscDesc, IconSortDesc } from "./icons";
import { formatDate, formatDateTime, formatTimeOfDay } from "@/utils/datetime";
import { ABILITY } from "@/utils/permissions";
import { cx } from "./ui";

/* ------------------------------------------------------------------ */
/* TanStack Table wiring. Shared, stable feature set.                  */
/* ------------------------------------------------------------------ */

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

/* Timestamps arrive as ISO 8601 instants, so sort on the parsed instant rather
   than on the rendered text — the display format carries no ordering ("Sep 24"
   sorts before "Sep 3" as a string). A legacy clock-only reading ("14:58:02")
   is still accepted and compared as seconds since midnight, so a stale payload
   cannot silently scramble the order. */
const toInstant = (t: string) => {
  const value = String(t ?? "");
  const ms = new Date(value).getTime();
  if (!Number.isNaN(ms)) return ms;
  const [h, m, s] = (value || "00:00:00").split(":").map(Number);
  return ((h || 0) * 60 + (m || 0)) * 60 + (s || 0);
};

const sortClock = constructSortFn({
  sort: (a, b) => toInstant(String(a ?? "")) - toInstant(String(b ?? "")),
});

/* Event stream type order: newest lifecycle phase first. */
const EVENT_ORDER: Record<EventType, number> = {
  "webhook-received": 0,
  collected: 1,
  "record-updated": 2,
  "sync-change": 3,
  initiated: 4,
  "payment-refunded": 5,
  "payment-declined": 6,
  "payment-failed": 7,
  // Adaptor reachability is infrastructure, not a payment phase: sorted below
  // the payment trail so one payment's own events stay together.
  "adaptor-restored": 8,
  "adaptor-unreachable": 9,
  "adaptor-auth-failed": 10,
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

const SORT_GLYPH: Record<"asc" | "desc", typeof IconSortAsc> = {
  asc: IconSortAsc,
  desc: IconSortDesc,
};

function SortGlyph({ dir }: { dir: false | "asc" | "desc" }) {
  const Glyph = dir === false ? IconSortAscDesc : SORT_GLYPH[dir];
  /* The unsorted "hint" pair is the faint ink; an active direction inherits the
     header's own ink. */
  return <Glyph size={12} className={cx("flex-none", dir === false && "text-ink-3")} />;
}

/* ------------------------------------------------------------------ */
/* Lifecycle event stream (FR-5.1).                                    */
/* ------------------------------------------------------------------ */

const EVENT_HEAD_LABEL: Record<string, string> = {
  at: "Date & time",
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
      header: "Date & time",
      sortFn: sortClock,
      /*
        Date over time, stacked. A single-line "Sep 24, 2026, 2:58:02 PM" needs
        ~190px of a fixed column that only has ~100 to give, and dropping the
        seconds to make it fit would lose information the log exists to hold.
        Both lines come from the shared formatter, so the pairing rule (a time
        never appears without its date) is still satisfied.
      */
      cell: (info) => {
        const iso = String(info.getValue());
        return (
          <span className="flex flex-col">
            <span className="mono text-sm whitespace-nowrap text-ink-3">{formatDate(iso)}</span>
            <span className="mono text-sm whitespace-nowrap text-ink-3">{formatTimeOfDay(iso)}</span>
          </span>
        );
      },
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

/*
  THE COLUMN TEMPLATE, IN ONE PLACE, because it is written twice — once for the
  header and once for every row — and the two were free to disagree, which is how a
  header ends up over one column and its cells under another.

  WHY THESE NUMBERS, since the previous ones read as arbitrary:

    `at`  is 96px because it renders a STACKED date over a time. Two lines of
         13px mono need about 80px of ink; it was given 108px, a column and a
         half of slack taken from the three columns that were actually cramped.
    `ref` is now its own minimum rather than sharing a fraction. It is a
         `whitespace-nowrap` hash, so a fractional track means its width depends
         on the viewport and the gutter does too — which is the specific way this
         table felt tight at some widths and not others.
    `gap-x-5` rather than `gap-x-3`. The gutters are the whole complaint: 12px
         between five columns puts a reference hash almost against the event name
         beside it, and the detail column has to be read as prose.
*/
const EVENT_GRID = "gap-x-5 px-4";
const EVENT_COLS = "grid-cols-[96px_136px_minmax(104px,0.7fr)_minmax(132px,1fr)_minmax(0,2.2fr)]";

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
        className={`grid ${EVENT_COLS} ${EVENT_GRID} border-b border-ink-2 bg-midnight-3 py-2 max-3xl:hidden`}
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
          className={`grid ${EVENT_COLS} ${EVENT_GRID} items-center border-b border-rule-enamel bg-midnight-2 py-2.5 transition-colors hover:bg-midnight-3 max-3xl:grid-cols-[96px_1fr_minmax(132px,1.4fr)] max-3xl:gap-x-4 max-md:grid-cols-[96px_1fr] max-md:gap-x-4`}
          role="row"
        >
          {row.getAllCells().map((cell) => (
            <Fragment key={cell.id}>
              {/*
                `role="cell"` is required, not decorative. The row declares
                role="row" inside a role="table", and an ARIA row with no cells
                is worse than a plain list: assistive tech announces a table and
                then contradicts itself — column association is lost and
                row/column navigation fails (SC 1.3.1, 4.1.2). FlexRender emits
                a bare span, so the role has to be supplied here.

                `contents` is equally load-bearing: the row is a 5-column grid,
                so a wrapper that generated a box would become a grid ITEM and
                collapse the layout. `display: contents` keeps the box out of
                the layout while leaving the element in the DOM as a child of
                the row, which is what ARIA ownership requires.
              */}
              <span role="cell" className="contents">
                {table.FlexRender({ cell })}
              </span>
            </Fragment>
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

function buildFindingsColumns(onAck: (id: string) => void): ColumnDef<any, Failure, unknown>[] {
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
        <span className="mono text-xs whitespace-nowrap text-ink-3">{formatDateTime(String(info.getValue()))}</span>
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
            <Can ability={ABILITY.findingAck}>
              <button className={FINDING_BTN_ACK} onClick={() => onAck(id)}>
                Acknowledge
              </button>
            </Can>
            <button className={FINDING_BTN_DETAIL}>Open detail</button>
          </span>
        );
      },
    },
  ];
}

export function FindingsTable({
  findings,
  onAck,
}: {
  findings: Failure[];
  onAck: (id: string) => void;
}) {
  const columns = useMemo(() => buildFindingsColumns(onAck), [onAck]);
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
                <span className="mono text-xs whitespace-nowrap text-ink-3">{formatDateTime(f.since)}</span>
              </div>
              <div className="flex flex-col items-start gap-1">
                <span className="text-md font-semibold leading-[1.3] text-ink-1">{f.title}</span>
                <span className="max-w-[46ch] text-xs leading-snug text-ink-2">{f.detail}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Can ability={ABILITY.findingAck}>
                  <button className={FINDING_BTN_ACK} onClick={() => onAck(f.id)}>
                    Acknowledge
                  </button>
                </Can>
                <button className={FINDING_BTN_DETAIL}>Open detail</button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
