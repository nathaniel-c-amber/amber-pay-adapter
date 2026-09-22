import type { Connector } from "@/types/domain";
import { HEALTH_OF, HEALTH_LABEL, type Health } from "@/utils/vocabulary";
import { cx } from "./ui";

/* ---- Gateway hub service map (the world's connectivity centrepiece) ----
   Grammar, from the gateway-hub drawing:
   - one hub at the centre of the plate; one straight spoke per connector,
     leaving on the 45° diagonals — no bends, no crossings
   - a spoke carries the route's LIVE STATE (healthy / degraded / failed),
     not the connector's identity ink: on this plate colour answers "is it
     working?". The key underneath keeps the four line-inks for identity, so
     the two languages stay separate instead of competing.
   - connectors sharing a terminus sit as a pair, so one destination reached
     by two paths reads as a pair rather than two strangers
   - state is never colour alone: solid / dashed / hatched, plus a word
   - focusing a node recedes the rest, so a single route can be read alone
*/

const VIEW_W = 920;
const VIEW_H = 480;
const HUB = { x: 460, y: 240 };
const HUB_R = 30;
const NODE_R = 17;
/* The ring the nodes sit on is an ellipse: the plate is wider than it is
   tall, and a circle would push the diagonal labels off the top and bottom. */
const RING = { rx: 353, ry: 215 };

/* ------------------------------------------------------------------ plate ----
   SVG is styled with explicit arbitrary *properties* (`[stroke-width:3]`)
   rather than the `stroke-*`/`fill-*` shorthands: `stroke-[3px]` is ambiguous
   between the stroke colour and the stroke width, and an ambiguous arbitrary
   utility is dropped silently.

   The route's ink is a single inherited custom property, `--node-ink`, set per
   `data-state` on the route group. Every part of the route draws from it, so
   state cannot be applied to the spoke but forgotten on the node. */
const ROUTE =
  "group cursor-pointer outline-none transition-opacity duration-[180ms] ease-out [--node-ink:var(--color-ink-4)] data-[dim=true]:opacity-[0.32] data-[state=healthy]:[--node-ink:var(--color-line-green)] data-[state=degraded]:[--node-ink:var(--color-state-delayed)] data-[state=failed]:[--node-ink:var(--color-state-suspended)]";

const SPOKE =
  "[stroke:var(--node-ink)] [stroke-width:3] [stroke-linecap:round] [transition:stroke-width_0.18s_ease-out] group-data-[active=true]:[stroke-width:5.5] group-data-[state=degraded]:[stroke-dasharray:7_6] group-data-[state=failed]:[stroke-dasharray:4_5] group-data-[state=failed]:animate-hatch group-data-[state=stopped]:[stroke-dasharray:2_7] group-data-[state=stopped]:[stroke-opacity:0.7] group-data-[state=unknown]:[stroke-dasharray:2_7] group-data-[state=unknown]:[stroke-opacity:0.7]";

const NODE_DISC =
  "[fill:var(--node-ink)] [stroke:var(--color-midnight-2)] [stroke-width:3] group-data-[state=failed]:[fill:url(#map-fail-hatch)] group-data-[state=failed]:[stroke:var(--node-ink)] group-data-[state=stopped]:[fill:var(--color-midnight-2)] group-data-[state=stopped]:[stroke:var(--node-ink)] group-data-[state=stopped]:[stroke-dasharray:2_4] group-data-[state=unknown]:[fill:var(--color-midnight-2)] group-data-[state=unknown]:[stroke:var(--node-ink)] group-data-[state=unknown]:[stroke-dasharray:2_4] group-data-[active=true]:[stroke:var(--color-midnight)] group-data-[active=true]:[stroke-width:4]";

/* The focus ring rings the node itself — a bounding-box outline would be a
   rectangle drawn across a spoke and two labels, not a control. The same
   circle is the pointer target, so the node is grabbable by more than the
   width of a 3px spoke. */
const NODE_FOCUS =
  "[fill:none] [stroke:transparent] [stroke-width:2] [pointer-events:all] group-focus-visible:[stroke:var(--color-focus)]";

/* Connector identity inks, for the key only: the plate spends its colour on
   state, so identity lives in the legend underneath. */
const KEY_LAMP: Record<string, string> = {
  scarlet: "bg-line-scarlet shadow-[0_0_0_1px_var(--color-line-scarlet)]",
  cobalt: "bg-line-cobalt shadow-[0_0_0_1px_var(--color-line-cobalt)]",
  amber: "bg-line-amber shadow-[0_0_0_1px_var(--color-line-amber)]",
  green: "bg-line-green shadow-[0_0_0_1px_var(--color-line-green)]",
};

/* The key uses the same health vocabulary as the rest of the console, so the
   map cannot name a state the tables do not. */
const KEY_STATUS: Record<Health, string> = {
  healthy: "text-line-green bg-state-tint-arriving",
  degraded: "text-state-delayed bg-state-tint-delayed",
  failed: "text-text-suspended bg-state-tint-suspended",
  stopped: "text-ink-3 bg-midnight-3",
  unknown: "text-ink-3 bg-midnight-3",
};

interface Vec {
  x: number;
  y: number;
}

interface Spoke {
  connector: Connector;
  health: Health;
  /** Spoke ends, inset from both rims so no ink touches a disc. */
  from: Vec;
  to: Vec;
  node: Vec;
  /** Which side of the node its labels sit on: 1 below, -1 above. */
  dir: 1 | -1;
  /** The node's second line — the state, and the path's name when a
      destination is reached by more than one connector. */
  sub: string;
}

/** Labels sit above or below their node, outward from the hub, and flip
    rather than run off the edge of the plate. */
function labelSide(node: Vec, sin: number): 1 | -1 {
  const band = NODE_R + 46;
  let dir: 1 | -1 = sin >= 0 ? 1 : -1;
  if (dir === 1 && node.y + band > VIEW_H) dir = -1;
  if (dir === -1 && node.y - band < 0) dir = 1;
  return dir;
}

/** Connectors grouped by terminus, first-appearance order, so a destination
    reached by two paths is laid out as a pair. */
function groupedByTerminus(connectors: Connector[]): Connector[] {
  const order: string[] = [];
  const groups = new Map<string, Connector[]>();
  for (const c of connectors) {
    const group = groups.get(c.terminus);
    if (group) group.push(c);
    else {
      groups.set(c.terminus, [c]);
      order.push(c.terminus);
    }
  }
  return order.flatMap((terminus) => groups.get(terminus) ?? []);
}

/**
 * Places the spokes clockwise from the bottom-right diagonal (45°), where the
 * reference drawing puts its first route: the two QuickBooks paths run along
 * the bottom, the audit trail and Sage across the top. Each spoke goes
 * straight from the hub rim to the node rim, so its angle is also the
 * direction its label is offset in.
 */
function layout(connectors: Connector[]): Spoke[] {
  const ordered = groupedByTerminus(connectors);
  const n = ordered.length;
  if (n === 0) return [];

  const shared = new Map<string, number>();
  for (const c of ordered) shared.set(c.terminus, (shared.get(c.terminus) ?? 0) + 1);

  /* A larger connector set pulls the ring in, so no label leaves the plate. */
  const scale = n <= 4 ? 1 : Math.max(0.62, 4 / n);
  const rx = RING.rx * scale;
  const ry = RING.ry * scale;

  return ordered.map((connector, index) => {
    const angle = Math.PI / 4 + (index * 2 * Math.PI) / n;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const node = { x: HUB.x + rx * cos, y: HUB.y + ry * sin };
    const health = HEALTH_OF[connector.status];
    const state = HEALTH_LABEL[health];
    return {
      connector,
      health,
      from: { x: HUB.x + (HUB_R + 3) * cos, y: HUB.y + (HUB_R + 3) * sin },
      to: { x: node.x - (NODE_R + 5) * cos, y: node.y - (NODE_R + 5) * sin },
      node,
      dir: labelSide(node, sin),
      sub: (shared.get(connector.terminus) ?? 0) > 1 ? `${connector.label} · ${state}` : state,
    };
  });
}

export function NetworkMap({
  connectors,
  activeId,
  onFocus,
  compact = false,
}: {
  connectors: Connector[];
  activeId: string | null;
  onFocus: (id: string | null) => void;
  /** Compact = the homepage preview: shorter plate, key hidden. */
  compact?: boolean;
}) {
  const spokes = layout(connectors);
  const toggle = (id: string) => onFocus(id === activeId ? null : id);

  /* The hub caption sits under the hub unless a spoke leaves straight down
     through that space, in which case it moves above instead. */
  const blocksBelow = spokes.some((s) => s.node.y > HUB.y && Math.abs(s.node.x - HUB.x) < 70);
  const blocksAbove = spokes.some((s) => s.node.y < HUB.y && Math.abs(s.node.x - HUB.x) < 70);
  const captionY = HUB.y + (blocksBelow && !blocksAbove ? -(HUB_R + 40) : HUB_R + 26);

  const described = connectors
    .map((c) => `${c.label} to ${c.terminus}, ${HEALTH_LABEL[HEALTH_OF[c.status]]}`)
    .join("; ");

  return (
    <div className="mt-4">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className={cx(
          "block h-auto w-full rounded-panel border border-rule-enamel bg-midnight-2 shadow-panel",
          compact && "max-h-[260px]",
        )}
        role="group"
        aria-label={`Gateway hub service map: Amber Pay at the centre, with ${connectors.length} connections — ${described}.`}
      >
        <title>Gateway hub and connector status</title>

        {/* Hatch fill for a failed node — the shape half of the state grammar,
            so a stopped route never reads as merely a redder one. */}
        <defs>
          <pattern
            id="map-fail-hatch"
            patternUnits="userSpaceOnUse"
            width="7"
            height="7"
            patternTransform="rotate(45)"
          >
            <rect className="[fill:var(--color-midnight-2)]" width="7" height="7" />
            <line
              className="[stroke:var(--color-state-suspended)] [stroke-width:2.5]"
              x1="0"
              y1="0"
              x2="0"
              y2="7"
            />
          </pattern>
        </defs>

        <rect className="[fill:var(--color-midnight-2)]" x="0" y="0" width={VIEW_W} height={VIEW_H} />

        {/* One route per connector: a spoke and the node it terminates in.
            The whole route is the button, so the label is a hit target too. */}
        {spokes.map((s) => {
          const active = s.connector.id === activeId;
          const state = s.health;
          return (
            <g
              key={s.connector.id}
              className={ROUTE}
              data-state={state}
              data-active={active}
              data-dim={activeId !== null && !active}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              aria-label={`${s.connector.label} to ${s.connector.terminus}: ${HEALTH_LABEL[state]}. ${
                active ? "Stop isolating this route" : "Isolate this route"
              }.`}
              onClick={() => toggle(s.connector.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggle(s.connector.id);
                }
              }}
            >
              <line className={SPOKE} x1={s.from.x} y1={s.from.y} x2={s.to.x} y2={s.to.y} />

              {(state === "degraded" || state === "failed") && (
                <circle
                  className="[fill:none] [stroke:var(--node-ink)] [stroke-width:1.5] [stroke-dasharray:4_5]"
                  cx={s.node.x}
                  cy={s.node.y}
                  r={NODE_R + 7}
                />
              )}
              <circle className={NODE_DISC} cx={s.node.x} cy={s.node.y} r={NODE_R} />
              {state === "failed" && (
                <line
                  className="[stroke:var(--node-ink)] [stroke-width:2.5] [stroke-linecap:round]"
                  x1={s.node.x - 9}
                  y1={s.node.y + 9}
                  x2={s.node.x + 9}
                  y2={s.node.y - 9}
                />
              )}
              <circle
                className={NODE_FOCUS}
                cx={s.node.x}
                cy={s.node.y}
                r={NODE_R + 11}
              />

              <text
                className="[fill:var(--color-ink-1)] [font-family:var(--font-sans)] [font-size:var(--text-sm)] [font-weight:var(--font-weight-semibold)] [letter-spacing:var(--tracking-tight)]"
                x={s.node.x}
                y={s.node.y + s.dir * (NODE_R + 14)}
                textAnchor="middle"
                dominantBaseline="middle"
                aria-hidden
              >
                {s.connector.terminus}
              </text>
              <text
                className="[fill:var(--color-ink-3)] [font-family:var(--font-mono)] [font-size:var(--text-micro)] group-data-[active=true]:[fill:var(--node-ink)]"
                x={s.node.x}
                y={s.node.y + s.dir * (NODE_R + 29)}
                textAnchor="middle"
                dominantBaseline="middle"
                aria-hidden
              >
                {s.sub}
              </text>
            </g>
          );
        })}

        {/* The hub itself carries no state ink — it is the platform, not a route. */}
        <g aria-hidden>
          <circle
            className="[fill:none] [stroke:var(--color-rule-enamel)] [stroke-width:1.5]"
            cx={HUB.x}
            cy={HUB.y}
            r={HUB_R + 9}
          />
          <circle
            className="[fill:var(--color-midnight-3)] [stroke:var(--color-ink-1)] [stroke-width:2]"
            cx={HUB.x}
            cy={HUB.y}
            r={HUB_R}
          />
          <text
            className="[fill:var(--color-ink-1)] [font-family:var(--font-sans)] [font-size:var(--text-md)] [font-weight:var(--font-weight-semibold)]"
            x={HUB.x}
            y={captionY}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            Amber Pay
          </text>
          <text
            className="[fill:var(--color-ink-3)] [font-family:var(--font-mono)] [font-size:var(--text-micro)]"
            x={HUB.x}
            y={captionY + 15}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            gateway hub
          </text>
        </g>
      </svg>

      {/* The key is the legend, not a second set of controls: the nodes above
          are the buttons. It carries the four line-inks so connector identity
          is not lost now that the plate spends its colour on state. */}
      <ul
        className={cx("mt-3 flex list-none flex-wrap gap-2 p-0", compact && "hidden")}
        aria-label="Connector key"
      >
        {connectors.map((c) => {
          const health = HEALTH_OF[c.status];
          return (
            <li
              key={c.id}
              className="inline-flex items-center gap-2 rounded-panel border border-rule-enamel bg-midnight-2 px-2 py-1.5 text-sm text-ink-2 data-[active=true]:border-ink-1 data-[active=true]:bg-midnight-3 data-[active=true]:text-ink-1"
              data-active={c.id === activeId}
            >
              <span
                className={cx("size-2.5 flex-none rounded-[2px]", KEY_LAMP[c.color] ?? "")}
                aria-hidden
              />
              <span className="font-semibold">{c.label}</span>
              <span className="text-xs text-ink-3">{c.terminus}</span>
              <span
                className={cx(
                  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-chip px-2 py-0.5 text-xs font-semibold",
                  KEY_STATUS[health],
                )}
              >
                <span className="size-[7px] flex-none rounded-[1px] bg-current" aria-hidden />
                {HEALTH_LABEL[health]}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
