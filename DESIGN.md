---
name: Amber Pay API Adaptor & Monitor System
description: A monitoring console that makes the gateway-to-accounting link legible as a midnight transit service map.
colors:
  midnight: "#0b1330"
  midnight-2: "#101a3e"
  midnight-3: "#16224d"
  midnight-raised: "#1a2a5e"
  porcelain: "#f6f7fc"
  porcelain-dim: "#b7c0e0"
  porcelain-faint: "#7f8bc0"
  rule-enamel: "#2a3a72"
  line-scarlet: "#d6403f"
  line-cobalt: "#3c6fe0"
  line-amber: "#e6a12a"
  line-green: "#39b98a"
  state-arriving: "#7fe7d2"
  state-delayed: "#e6a12a"
  state-suspended: "#d6403f"
  text-suspended: "#ee6159"
typography:
  body:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.35
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontWeight: 500
    letterSpacing: "normal"
    fontFeature: "tnum, lnum"
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "0.7rem"
    fontWeight: 500
    letterSpacing: "0.04em"
    textTransform: "uppercase"
rounded:
  sm: "3px"
  md: "3px"
spacing:
  sm: "0.4rem"
  md: "0.8rem"
  lg: "1rem"
components:
  status-chip:
    backgroundColor: "{colors.midnight-2}"
    textColor: "{colors.porcelain}"
    borderColor: "{colors.rule-enamel}"
    rounded: "{rounded.sm}"
  tag-open:
    backgroundColor: "rgba(127, 231, 210, 0.16)"
    textColor: "{colors.line-green}"
    rounded: "{rounded.sm}"
  tag-suspended:
    backgroundColor: "rgba(214, 64, 63, 0.16)"
    textColor: "{colors.text-suspended}"
    rounded: "{rounded.sm}"
  finding-ack:
    backgroundColor: "{colors.line-cobalt}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "0.28rem 0.55rem"
  scope-select:
    backgroundColor: "{colors.midnight-2}"
    textColor: "{colors.porcelain}"
    borderColor: "{colors.rule-enamel}"
    rounded: "{rounded.md}"
---

# Design System: Amber Pay API Adaptor & Monitor System

## Overview

**Creative North Star: "The Midnight Transit Diagonal"**

The console is the operating network made legible as a service map on a midnight-enamel wall: every connector between the Amber Pay gateway and an accounting adaptor is a coloured line, and its live service state is what an operator reads first. It is quiet by default — deep midnight ground, porcelain ticks, ruled enamel hairlines — so that a single suspended line, burning a broken hatch, is unmissable. Nothing that needs a look can be scrolled past.

**Key Characteristics:**
- A dark, near-black midnight-enamel ground with low-contrast ruled hairlines; the surface is a board, not a paper page.
- Coloured transit line inks reserved for connection routes, never decoration; the focused line burns brightest and the rest recede.
- Hard 45°/90° bend discipline, porcelain-white station ticks, interchange circles at crossings.
- Operative readouts and references in a monospaced face so they align and scan; labels in a workhorse sans.
- Status is never signalled by colour alone: a text label, a shape mark, and (on the suspended line) a hatch texture all carry the state.

## Colors

The palette is a single midnight enamel family carrying the field, with four transit line inks and three service-state accents. Almost everything is the ground; the colour is spent where it means something.

### Primary
- **Midnight** (#0b1330): The board ground and the global field.
- **Midnight-2** (#101a3e): The secondary ground for rails, panels, and raised chrome strips.
- **Midnight-3** (#16224d): Raised surfaces, hover states, and selected control fields.
- **Midnight-raised** (#1a2a5e): The brightest enamel step, for the most elevated controls.

### Secondary
- **Porcelain** (#f6f7fc): Primary ink for headings and body text on the enamel.
- **Porcelain-dim** (#b7c0e0): Secondary ink (labels, captions, secondary text). ≥9:1 on midnight.
- **Porcelain-faint** (#7f8bc0): Tertiary ink (faint notes, timestamps). ≥5.5:1 on midnight.

### Tertiary
- **Rule-enamel** (#2a3a72): Hairline rulings and control borders on the board.
- **Rule-enamel-soft** (#1e2c5a): Softer hairlines and quiet dividers.

### Line inks (transit routes)
- **Scarlet** (#d6403f): The payment-push route.
- **Cobalt** (#3c6fe0): The scheduled-pull route, and the primary action/reference accent.
- **Amber** (#e6a12a): The Sage bridge, and the "delayed" service state.
- **Green** (#39b98a): The event-log / audit route, and the "open" service state.

### Service state
- **Arriving** (#7fe7d2): A line mid-flight; tinted chip and the arriving station dot.
- **Delayed** (#e6a12a): A line running behind; tinted chip.
- **Suspended** (#d6403f): A line stopped; the broken hatch and tinted chip. For small text, **text-suspended** (#ee6159) is used to hold ≥4.5:1 contrast.

**The One Voice Rule.** The four transit inks and three service states carry the whole system. No colour is decorative: every tint either marks a connector route or a service state, never an ornament.

**The Status-Is-Never-Colour Rule.** A connector or finding state renders a text label, a shape mark (station dot / lamp), and — on the suspended line — a hatch texture. Two cues minimum, never colour alone.

## Typography

**Body Font:** IBM Plex Sans (400/500/600) with system fallback.
**Label/Mono Font:** IBM Plex Mono (400/500/600) with tabular figures for every count, reference, and readout.

**Character:** The workhorse sans does the talking; the mono carries the numbers and refs so columns align and scan. A single-wall system with no display face — appropriate to an Operate surface.

### Hierarchy
- **Headline** (600, 1.3rem, 1.2): The single page heading (e.g. "Connector Monitor").
- **Title** (600, 1rem, 1.2): Section headings (Connector map, Channels, Findings).
- **Label** (500, 0.7rem, uppercase, +0.04em): Rule labels and column headers, set in Plex Mono.
- **Body** (400, 0.82rem, 1.35): Body and captions; measure capped at 72ch.
- **Data / ref** (500, 0.7–0.78rem, mono with `tnum`/`lnum`): Every reference, timestamp, and readout.

**The Tabular Rule.** Every count, reference, timestamp, and readout renders in Plex Mono with tabular figures, so numeric columns align down their runs.

## Layout

The console is tri-partite on desktop: a narrow system rail (220px) listing each connector, the connector board (fluid) holding the service map and event stream, and a findings rail (300px). The service map is a fixed `viewBox` SVG that scales to its column. Responsible collapse: at ≤1080px the findings rail drops to full width below the board and the rail narrows; at ≤720px the shell becomes single column and the rail stacks on top. The event stream collapses columns at 1080 (drops ref + channel) and 720 (drops detail). Spacing rhythm: tight groups at 0.4rem, section gaps at 0.8–1rem, with more space above a heading than below it.

## Elevation & Depth

The world is enamel, so depth is a low soft lift rather than shadow drama. `--shadow-soft` (0 2px 8px) is a diffuse lift under raised panels; `--shadow-panel` adds a 1px enamel keyline. There is no hard offset shadow, no glow, and no neubrutalist block shadow. Committed lines and chips sit flat on the ground; only the raised chrome strips and the service-map panel carry the soft lift.

## Shapes

Corner language is a hard, small radius: 3px for chips, controls, and focus rings. Station ticks are porcelain circles; interchange circles are a hollow ring with a filled core. The service map bends only at 45° and 90° — the diagonal discipline is the geometry of the world. Everything is sharp and booklike; no pill-shaped comfort.

## Components

### Buttons
- **Acknowledge (primary):** Cobalt fill (#3c6fe0), white label, 3px radius, 0.28rem/0.55rem padding. Hover darkens to #2b55c2. Disabled (read-only scope) becomes midnight-3 with faint text and an enamel border.
- **Open detail (secondary):** Transparent, arriving/teal label, 1px enamel border. Hover fills midnight-3.

### Chips / Status tags
- **Tag style:** Tinted background per state (open arrives on a teal tint, delayed on amber, suspended on red), label in the state colour, 3px radius, with a square shape mark that carries the current colour. Text on the suspended chip uses text-suspended (#ee6159) for contrast.
- **Status chip (header):** Midnight-2 fill, 1px enamel border, porcelain label, with a round dot.

### Cards / Containers
- **Connector (rail):** Midnight fill, 1px enamel rule, 3px radius; a colour lamp, weight-600 label, mono readout, and a status chip stacked within.
- **Finding item:** Midnight fill, 1px enamel rule, stacked head (severity + id + channel + since), title + detail, and actions.
- **Empty state:** 1px dashed enamel border, midnight-2 fill.

### Inputs / Select
- **Scope select:** Midnight-2 fill, 1px enamel border, porcelain label, 3px radius. Focus shows the 2px teal ring.

### Navigation
- The rail is the navigation: a vertical list of connectors, each a selectable unit with a colour lamp and live status. No top-nav tabs; the header is a rebate carrying status + scope.

### Network service map (signature)
- The centerpiece SVG: midnight-enamel ground (`--midnight-2`), porcelain station ticks, four colour routes with hard 45/90° bends, hollow-core interchange circles at crossings, and the hub "Amber Pay" interchange. The focused line burns at 7px while others sit at 3.5px at ~50% opacity; a suspended line overlays a dashed state hatch that pulses at 1.6s (steps), suppressed under `prefers-reduced-motion`. The key below the map is the keyboard-operable focus control (`aria-pressed`).

## Do's and Don'ts

### Do:
- **Do** spend colour only on connector routes and service states; the ground stays midnight.
- **Do** render every count, reference, and readout in the mono face with tabular figures.
- **Do** bend the service map only at 45° and 90°, and give station ticks and interchange circles consistent porcelain/white treatments.
- **Do** convey a status with a label plus a shape mark (and a hatch on suspended), never colour alone.
- **Do** use the brighter text-suspended (#ee6159) for small red text so it holds 4.5:1.

### Don't:
- **Don't** use a coloured left/right border wider than 1px on a card or list item; carry state with a lamp, label, and tint instead.
- **Don't** add a hard offset or glow shadow; depth is a soft low lift on enamel.
- **Don't** put financial amounts, customer PII, or ledger figures anywhere in the console (FR-2.3 / FR-5.2) — the surface is operational events only.
- **Don't** introduce a display serif or a second wall; one sans + one mono carry the system.
- **Don't** use a static role dropdown; scope is policy-driven (PBAC) and shown as a scope indicator.
