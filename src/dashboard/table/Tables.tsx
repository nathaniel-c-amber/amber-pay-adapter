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
import { EVENT_LABEL } from "../data";
import type { EventType, Failure, LifecycleEvent } from "../data";

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

function SortGlyph({ dir }: { dir: false | "asc" | "desc" }) {
  const d = dir === false ? SORT_GLYPH_HINT : SORT_GLYPH[dir];
  const cls = dir === false ? "sort-glyph hint" : "sort-glyph";
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
      cell: (info) => <span className="evcol-at event-at mono">{String(info.getValue())}</span>,
    },
    {
      id: "type",
      accessorKey: "type",
      header: "Event",
      sortFn: sortEventType,
      cell: (info) => (
        <span className="evcol-type">
          <span className="event-type-mark" aria-hidden />
          {EVENT_LABEL[String(info.getValue()) as EventType] ?? "Event"}
        </span>
      ),
    },
    {
      id: "ref",
      accessorKey: "ref",
      header: "Ref",
      sortFn: sortFn_alphanumeric,
      cell: (info) => <span className="evcol-ref event-ref mono">{String(info.getValue())}</span>,
    },
    {
      id: "channel",
      accessorKey: "channel",
      header: "Channel",
      sortFn: sortFn_text,
      cell: (info) => <span className="evcol-channel event-channel">{String(info.getValue())}</span>,
    },
    {
      id: "detail",
      accessorKey: "detail",
      header: "Detail",
      sortFn: sortFn_text,
      cell: (info) => <span className="evcol-detail event-detail">{String(info.getValue())}</span>,
    },
  ];
}

const EVENT_HEAD_CLASS: Record<string, string> = {
  at: "",
  type: "",
  ref: "",
  channel: "",
  detail: "",
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
    <div className="event-stream" role="table" aria-label="Lifecycle event stream">
      <div className="event-stream-head" role="row">
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
                  className="sort-trigger"
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
        <div key={row.id} className="event-stream-row" role="row">
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
          <span className="fcol-severity finding-sev-cell">
            <span className={`finding-lamp finding-lamp--${s}`} aria-hidden />
            <span className={`finding-sev finding-sev--${s}`}>{s}</span>
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
        <span className="fcol-finding finding-id-cell mono">{String(info.getValue())}</span>
      ),
    },
    {
      id: "channel",
      accessorKey: "channel",
      header: "Channel",
      sortFn: sortFn_text,
      cell: (info) => <span className="fcol-channel finding-channel">{String(info.getValue())}</span>,
    },
    {
      id: "issue",
      accessorKey: "title",
      header: "Issue",
      sortFn: sortFn_text,
      cell: (info) => (
        <span className="fcol-issue finding-issue">
          <span className="finding-title-cell">{String(info.getValue())}</span>
          <span className="finding-detail-cell">{info.row.original.detail}</span>
        </span>
      ),
    },
    {
      id: "since",
      accessorKey: "since",
      header: "Since",
      sortFn: sortClock,
      cell: (info) => <span className="fcol-since finding-since mono">{String(info.getValue())}</span>,
    },
    {
      id: "action",
      header: "",
      enableSorting: false,
      cell: (info) => {
        const id = info.row.original.id;
        return (
          <span className="fcol-action finding-actions-cell">
            <button className="finding-btn ack" disabled={!canAck} onClick={() => onAck(id)}>
              Acknowledge
            </button>
            <button className="finding-btn detail-link">Open detail</button>
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
        className="sort-trigger"
        onClick={header.column.getToggleSortingHandler()}
        aria-label={`Sort ${label}`}
      >
        {label}
        <SortGlyph dir={dir} />
      </button>
    );
  };

  return (
    <div className="finding-list" role="list" aria-label="Active failures">
      <div className="finding-list-head" aria-hidden>
        <span>{sortCell("severity", "Severity")}</span>
        <span>{sortCell("since", "Since")}</span>
      </div>
      {table.getRowModel().rows.length === 0 ? (
        <div className="empty-state">
          <h3>All clear</h3>
          <p>No open findings. Every connector is open and the sync loop is healthy.</p>
        </div>
      ) : (
        table.getRowModel().rows.map((row) => {
          const f = row.original;
          return (
            <div key={row.id} className="finding-item" role="listitem" data-severity={f.severity}>
              <div className="finding-item-head">
                <span className="fcol-severity finding-sev-cell">
                  <span className={`finding-lamp finding-lamp--${f.severity}`} aria-hidden />
                  <span className={`finding-sev finding-sev--${f.severity}`}>{f.severity}</span>
                </span>
                <span className="finding-id-cell mono">{f.id}</span>
                <span className="finding-channel">{f.channel}</span>
                <span className="finding-since mono">{f.since}</span>
              </div>
              <div className="finding-issue">
                <span className="finding-title-cell">{f.title}</span>
                <span className="finding-detail-cell">{f.detail}</span>
              </div>
              <div className="finding-actions-cell">
                <button className="finding-btn ack" disabled={!canAck} onClick={() => onAck(f.id)}>
                  Acknowledge
                </button>
                <button className="finding-btn detail-link">Open detail</button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
