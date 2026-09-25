import type { Connector } from "@/types/domain";
import { HEALTH_OF, HEALTH_LABEL, type Health } from "@/utils/vocabulary";
import { cx } from "./ui";

/* ---- The service map: a left-to-right pipeline ----
   Grammar:
   - THREE nodes on one axis: the payment gateway, the hub, and the accounting
     system. Payments enter on the left and records land on the right, so the
     reading direction matches the money's.
   - THE AUDIT TRAIL IS NOT DRAWN. It is not a route between the gateway and the
     ledger, so putting it on a pipeline would say something untrue about it. It
     stays in the list underneath, where it is still a status somebody can read.
   - a line carries the route's LIVE STATE (healthy / degraded / failed), not the
     connector's identity ink: on this plate colour answers "is it working?".
     The key underneath keeps the line-inks for identity, so the two languages
     stay separate instead of competing.
   - state is never colour alone: solid / dashed / hatched, plus a word

   THIS REPLACED A RADIAL HUB. The ring geometry, the label-side flip, the
   caption-collision avoidance and the ring-pull for large connector sets are all
   gone: a horizontal line has none of the problems they existed to solve. One
   adaptor per deployment means the plate almost always draws a single route,
   which is the case a radial layout was worst at — and the dead `compact` prop
   went with it (no call site ever passed it, and its "homepage preview" doc
   comment described a surface that does not exist).
*/

const VIEW_W = 920;
const VIEW_H = 300;
const NODE_R = 22;
const AXIS_Y = 150;

/* Three fixed columns, with wide gutters: a horizontal plate's characteristic
   failure is a long adaptor name running into the node beside it, which a radial
   layout never had to solve. */
const GATEWAY = { x: 150, y: AXIS_Y };
const HUB = { x: 460, y: AXIS_Y };
const LEDGER = { x: 770, y: AXIS_Y };

/** Termini that are not part of the gateway-to-ledger pipeline. */
const OFF_PIPELINE = new Set(["audit-trail"]);

/* ------------------------------------------------------------------ plate ----
   SVG is styled with explicit arbitrary *properties* (`[stroke-width:3]`)
   rather than the `stroke-*`/`fill-*` shorthands: `stroke-[3px]` is ambiguous
   between the stroke colour and the stroke width, and an ambiguous arbitrary
   utility is dropped silently.

   The route's ink is a single inherited custom property, `--node-ink`, set per
   `data-state` on the route group. Every part of the route draws from it, so
   state cannot be applied to a line but forgotten on the node. */
const ROUTE =
  "group cursor-pointer outline-none transition-opacity duration-[180ms] ease-out [--node-ink:var(--color-ink-4)] data-[dim=true]:opacity-[0.32] data-[state=healthy]:[--node-ink:var(--color-line-green)] data-[state=degraded]:[--node-ink:var(--color-state-delayed)] data-[state=failed]:[--node-ink:var(--color-state-suspended)]";

const SPOKE =
  "[stroke:var(--node-ink)] [stroke-width:3] [stroke-linecap:round] [transition:stroke-width_0.18s_ease-out] group-data-[active=true]:[stroke-width:5.5] group-data-[state=degraded]:[stroke-dasharray:7_6] group-data-[state=failed]:[stroke-dasharray:4_5] group-data-[state=failed]:animate-hatch group-data-[state=stopped]:[stroke-dasharray:2_7] group-data-[state=stopped]:[stroke-opacity:0.7] group-data-[state=unknown]:[stroke-dasharray:2_7] group-data-[state=unknown]:[stroke-opacity:0.7]";

const NODE_DISC =
  "[fill:var(--node-ink)] [stroke:var(--color-midnight-2)] [stroke-width:3] group-data-[state=failed]:[fill:url(#map-fail-hatch)] group-data-[state=failed]:[stroke:var(--node-ink)] group-data-[state=stopped]:[fill:var(--color-midnight-2)] group-data-[state=stopped]:[stroke:var(--node-ink)] group-data-[state=stopped]:[stroke-dasharray:2_4] group-data-[state=unknown]:[fill:var(--color-midnight-2)] group-data-[state=unknown]:[stroke:var(--node-ink)] group-data-[state=unknown]:[stroke-dasharray:2_4] group-data-[active=true]:[stroke:var(--color-midnight)] group-data-[active=true]:[stroke-width:4]";

/* The focus ring rings the node itself — a bounding-box outline would be a
   rectangle drawn across a line and two labels, not a control. The same circle is
   the pointer target, so the node is grabbable by more than the width of a 3px
   line. It stays a CIRCLE because the nodes stay discs; a rounded rect would only
   be needed if the nodes became boxes. */
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

const LABEL_CLASS =
  "[fill:var(--color-ink-1)] [font-family:var(--font-sans)] [font-size:var(--text-md)] [font-weight:var(--font-weight-semibold)]";
const SUB_CLASS =
  "[fill:var(--color-ink-3)] [font-family:var(--font-mono)] [font-size:var(--text-micro)]";

/** Health, worst first. Used to reduce a set of routes to one honest reading. */
const SEVERITY: readonly Health[] = ["healthy", "degraded", "stopped", "unknown", "failed"];

function worstOf(states: readonly Health[]): Health {
  if (states.length === 0) return "unknown";
  return states.reduce((worst, next) =>
    SEVERITY.indexOf(next) > SEVERITY.indexOf(worst) ? next : worst,
  );
}

/** The routes that belong on the pipeline: the gateway-to-ledger ones. */
function onPipeline(connectors: Connector[]): Connector[] {
  return connectors.filter((c) => !OFF_PIPELINE.has(c.terminus));
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
  const routes = onPipeline(connectors);
  const toggle = (id: string) => onFocus(id === activeId ? null : id);

  /*
    THE DRAWN PIPE REFLECTS THE WORST ROUTE ON IT, and the copy says so.

    One adaptor per deployment means this is normally a single route, drawn
    exactly. If a deployment ever carries more — a half-finished upgrade, say —
    the pipe takes the worst state among them, because a line reading "healthy"
    while one of its routes has failed is precisely the false reassurance this
    plate exists to prevent. The key underneath still lists every connector
    separately with its own state.
  */
  const state = worstOf(routes.map((c) => HEALTH_OF[c.status]));
  const active = routes.some((c) => c.id === activeId);

  const described =
    routes.length === 0
      ? "no accounting route is configured yet"
      : routes
          .map((c) => `${c.label} to ${c.terminus}, ${HEALTH_LABEL[HEALTH_OF[c.status]]}`)
          .join("; ");

  return (
    <div className="mt-4">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="block h-auto w-full rounded-panel border border-rule-enamel bg-midnight-2 shadow-panel"
        role="group"
        aria-label={`Gateway to ledger service map, read left to right: payment gateway, connection hub, then the accounting system. ${described}.`}
      >
        <title>Payment gateway, connection hub and accounting system</title>

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

        {/* The pipe, in two spans so the hub sits between them. One group, so the
            state ink is set once and both spans and the node draw from it. */}
        <g className={ROUTE} data-state={state} data-active={active} data-dim={false} aria-hidden>
          <line className={SPOKE} x1={GATEWAY.x + NODE_R + 6} y1={AXIS_Y} x2={HUB.x - NODE_R - 6} y2={AXIS_Y} />
          <line className={SPOKE} x1={HUB.x + NODE_R + 6} y1={AXIS_Y} x2={LEDGER.x - NODE_R - 6} y2={AXIS_Y} />
        </g>

        {/* Flow direction. A plain chevron rather than an animation: an arrow that
            keeps pointing the way money goes costs nothing, and one more looping
            animation is one more thing to suppress under reduced motion. */}
        <path
          className="[stroke:var(--color-ink-4)] [stroke-width:2] [fill:none] [stroke-linecap:round] [stroke-linejoin:round]"
          d={`M ${HUB.x + 76} ${AXIS_Y - 7} l 9 7 l -9 7`}
          aria-hidden
        />

        {/* The gateway carries no state ink: it is the platform the route starts
            from, not a route. */}
        <g aria-hidden>
          <circle
            className="[fill:var(--color-midnight-3)] [stroke:var(--color-ink-1)] [stroke-width:2]"
            cx={GATEWAY.x}
            cy={AXIS_Y}
            r={NODE_R}
          />
          <text className={LABEL_CLASS} x={GATEWAY.x} y={AXIS_Y + NODE_R + 26} textAnchor="middle" dominantBaseline="middle">
            Amber Pay
          </text>
          <text className={SUB_CLASS} x={GATEWAY.x} y={AXIS_Y + NODE_R + 44} textAnchor="middle" dominantBaseline="middle">
            payment gateway
          </text>
        </g>

        {/* The hub, for the same reason. */}
        <g aria-hidden>
          <circle
            className="[fill:none] [stroke:var(--color-rule-enamel)] [stroke-width:1.5]"
            cx={HUB.x}
            cy={AXIS_Y}
            r={NODE_R + 8}
          />
          <circle
            className="[fill:var(--color-midnight-3)] [stroke:var(--color-ink-1)] [stroke-width:2]"
            cx={HUB.x}
            cy={AXIS_Y}
            r={NODE_R}
          />
          <text className={LABEL_CLASS} x={HUB.x} y={AXIS_Y + NODE_R + 26} textAnchor="middle" dominantBaseline="middle">
            Hub
          </text>
          <text className={SUB_CLASS} x={HUB.x} y={AXIS_Y + NODE_R + 44} textAnchor="middle" dominantBaseline="middle">
            this deployment
          </text>
        </g>

        {/* The accounting side, which DOES carry state and IS the control: the whole
            group is the button, so its labels are a hit target too. */}
        <g
          className={ROUTE}
          data-state={state}
          data-active={active}
          data-dim={false}
          role="button"
          tabIndex={0}
          aria-pressed={active}
          aria-label={
            routes.length === 0
              ? "No accounting route is configured yet."
              : `Accounting connection, ${HEALTH_LABEL[state]}. ${
                  active ? "Stop highlighting" : "Highlight"
                } this route.`
          }
          onClick={() => routes[0] && toggle(routes[0].id)}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === " ") && routes[0]) {
              event.preventDefault();
              toggle(routes[0].id);
            }
          }}
        >
          {(state === "degraded" || state === "failed") && (
            <circle
              className="[fill:none] [stroke:var(--node-ink)] [stroke-width:1.5] [stroke-dasharray:4_5]"
              cx={LEDGER.x}
              cy={AXIS_Y}
              r={NODE_R + 7}
            />
          )}
          <circle className={NODE_DISC} cx={LEDGER.x} cy={AXIS_Y} r={NODE_R} />
          {state === "failed" && (
            <line
              className="[stroke:var(--node-ink)] [stroke-width:2.5] [stroke-linecap:round]"
              x1={LEDGER.x - 10}
              y1={AXIS_Y + 10}
              x2={LEDGER.x + 10}
              y2={AXIS_Y - 10}
            />
          )}
          <circle className={NODE_FOCUS} cx={LEDGER.x} cy={AXIS_Y} r={NODE_R + 11} />

          <text
            className={cx(LABEL_CLASS, "group-data-[active=true]:[fill:var(--node-ink)]")}
            x={LEDGER.x}
            y={AXIS_Y + NODE_R + 26}
            textAnchor="middle"
            dominantBaseline="middle"
            aria-hidden
          >
            {routes[0]?.label ?? "No accounting system"}
          </text>
          <text
            className={cx(SUB_CLASS, "group-data-[active=true]:[fill:var(--node-ink)]")}
            x={LEDGER.x}
            y={AXIS_Y + NODE_R + 44}
            textAnchor="middle"
            dominantBaseline="middle"
            aria-hidden
          >
            {routes[0] ? HEALTH_LABEL[state] : "not configured"}
          </text>
        </g>
      </svg>

      {/* The key is the legend, not a second set of controls: the node above is the
          button. It carries the line-inks so connector identity is not lost now
          that the plate spends its colour on state, and it lists EVERY connector —
          including the audit trail, which the pipeline does not draw. */}
      <ul className="mt-3 flex list-none flex-wrap gap-2 p-0" aria-label="Connector key">
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
