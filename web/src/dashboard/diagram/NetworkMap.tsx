import type { Connector } from "../data";

/* ---- Midnight transit service-map (the world's centerpiece) ------------
   Grammar from the Midnight Transit Diagonal:
   - midnight-enamel ground, porcelain-white station ticks
   - line inks per connector, active line burns brightest, others recede
   - lines bend only at 45°/90°, interchange circles mark crossings
   - live service state per segment (open / arriving / delayed / suspended)
*/

const COLOR: Record<Connector["color"], string> = {
  scarlet: "var(--line-scarlet)",
  cobalt: "var(--line-cobalt)",
  amber: "var(--line-amber)",
  green: "var(--line-green)",
};

interface Vec {
  x: number;
  y: number;
}

function line(pts: Vec[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

/* Station ticks distributed at even intervals along a horizontal run. */
function ticksX(a: Vec, b: Vec, n: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y });
  }
  return out;
}

function Ticks({ pts, status }: { pts: Vec[]; status: Connector["status"] }) {
  const cls: Record<Connector["status"], string> = {
    open: "station-dot",
    arriving: "station-dot station-dot--arriving",
    delayed: "station-dot station-dot--delayed",
    suspended: "station-dot station-dot--suspended",
  };
  return (
    <g aria-hidden>
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={4} className={cls[status]} />
      ))}
    </g>
  );
}

function Interchange({ x, y, r = 15 }: { x: number; y: number; r?: number }) {
  return (
    <g aria-hidden>
      <circle cx={x} cy={y} r={r} className="interchange" />
      <circle cx={x} cy={y} r={r * 0.55} className="interchange-core" />
    </g>
  );
}

function Terminus({
  x,
  y,
  label,
  sub,
  anchor = "bottom",
}: {
  x: number;
  y: number;
  label: string;
  sub?: string;
  anchor?: "bottom" | "top";
}) {
  const labelY = anchor === "bottom" ? y - 26 : y + 26;
  const subY = anchor === "bottom" ? y + 38 : y - 38;
  return (
    <g className="terminus">
      <Interchange x={x} y={y} r={14} />
      <text x={x} y={labelY} textAnchor="middle" className="map-terminus-label">
        {label}
      </text>
      {sub && (
        <text x={x} y={subY} textAnchor="middle" className="map-terminus-sub">
          {sub}
        </text>
      )}
    </g>
  );
}

/* The route for each connector; recomputed live from the state so a
   suspended line visibly breaks with a hatch, not just a colour swap.
   Lines fan from the hub at 45°/90° to their terminus; terminals are
   tiered so no two labels collide. */
function routeFor(c: Connector): { d: string; ticks: Vec[] } {
  const hub: Vec = { x: 150, y: 240 };
  switch (c.id) {
    case "push":
      return {
        d: line([hub, { x: 260, y: 150 }, { x: 790, y: 150 }]),
        ticks: ticksX({ x: 300, y: 150 }, { x: 760, y: 150 }, 6),
      };
    case "pull":
      return {
        d: line([hub, { x: 300, y: 60 }, { x: 790, y: 60 }]),
        ticks: ticksX({ x: 340, y: 60 }, { x: 760, y: 60 }, 5),
      };
    case "sage":
      return {
        d: line([hub, { x: 300, y: 330 }, { x: 790, y: 330 }]),
        ticks: ticksX({ x: 340, y: 330 }, { x: 760, y: 330 }, 5),
      };
    case "events":
      return {
        d: line([hub, { x: 790, y: 240 }]),
        ticks: ticksX({ x: 300, y: 240 }, { x: 760, y: 240 }, 7),
      };
    default:
      return { d: line([hub, { x: 790, y: 240 }]), ticks: [] };
  }
}

export function NetworkMap({
  connectors,
  activeId,
  onFocus,
}: {
  connectors: Connector[];
  activeId: string | null;
  onFocus: (id: string | null) => void;
}) {
  return (
    <div className="network-map-shell">
      <svg viewBox="0 0 920 480" className="network-map" role="img" aria-label="Connector service map: Amber Pay to accounting adaptors">
        <rect x="0" y="0" width="920" height="480" className="map-ground" />

        {connectors.map((c) => {
          const { d, ticks } = routeFor(c);
          const active = c.id === activeId;
          return (
            <g
              key={c.id}
              className="map-line-group"
              data-active={active}
            >
              <path
                d={d}
                fill="none"
                stroke={COLOR[c.color]}
                strokeWidth={active ? 7 : 3.5}
                strokeOpacity={active ? 1 : 0.5}
                strokeLinejoin="round"
                className="map-line-track"
              />
              {c.status === "suspended" && (
                <path
                  d={d}
                  fill="none"
                  stroke="var(--state-suspended)"
                  strokeWidth={active ? 7 : 3.5}
                  strokeDasharray="2 6"
                  className="map-line-hatch"
                />
              )}
              <Ticks pts={ticks} status={c.status} />
            </g>
          );
        })}

        {/* Interchange crossings on the diagram */}
        <Interchange x={150} y={240} r={20} />

        {/* Termini, tiered 90px apart so no two labels collide */}
        <Terminus x={810} y={60} label="QuickBooks Online" sub="Payment push" anchor="top" />
        <Terminus x={810} y={150} label="QuickBooks Online" sub="Scheduled pull" />
        <Terminus x={810} y={240} label="Audit trail" sub="Lifecycle stream" anchor="top" />
        <Terminus x={810} y={330} label="Sage" sub="Suspended" />

        {/* Hub crown */}
        <text x={150} y={288} textAnchor="middle" className="map-hub-label">
          Amber Pay
        </text>
        <text x={150} y={304} textAnchor="middle" className="map-hub-sub">
          gateway hub
        </text>
      </svg>

      <ul className="map-key" aria-label="Line key">
        {connectors.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="map-key-btn"
              data-active={c.id === activeId}
              onClick={() => onFocus(c.id === activeId ? null : c.id)}
              aria-pressed={c.id === activeId}
            >
              <span className="map-key-swatch" style={{ background: COLOR[c.color] }} aria-hidden />
              <span className="map-key-name">{c.label}</span>
              <span className={`map-key-status ${c.status}`}>
                <span className="mark" aria-hidden />
                {c.status === "open" ? "Open" : c.status === "arriving" ? "Arriving" : c.status === "delayed" ? "Delayed" : "Suspended"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
