---
name: Amber Pay API Adaptor & Monitor System
description: A dark-first multi-page operations console that makes the gateway-to-accounting link legible at a glance.
colors:
  ground: "#0a0e1a"
  surface: "#111827"
  surface-raised: "#1a2236"
  surface-bright: "#1e293b"
  ink: "#f1f5f9"
  ink-dim: "#94a3b8"
  ink-faint: "#7c8ba0"
  rule: "#1e293b"
  rule-soft: "#1a2236"
  primary: "#ef6000"
  primary-hover: "#ff7a1a"
  primary-ink: "#ff8c33"
  secondary: "#bf7ab2"
  secondary-hover: "#d49cc4"
  secondary-ink: "#d49cc4"
  line-scarlet: "#d6403f"
  line-cobalt: "#3c6fe0"
  line-amber: "#e6a12a"
  line-green: "#39b98a"
  health-healthy: "#39b98a"
  health-degraded: "#fbbf24"
  health-failed: "#f87171"
  severity-critical: "#f87171"
  severity-warning: "#fbbf24"
  severity-info: "#d49cc4"
typography:
  body:
    fontFamily: "IBM Plex Sans, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.84rem"
    fontWeight: 400
    lineHeight: 1.35
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontWeight: 500
    letterSpacing: "normal"
    fontFeature: "tnum, lnum"
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "0.68rem"
    fontWeight: 500
    letterSpacing: "0.05em"
    textTransform: "uppercase"
rounded:
  # Keyed by token name (`--radius-panel` / `--radius-chip`), matching the
  # semantic style of `colors:` above. A t-shirt scale would encode an ordering
  # these two no longer have — see "Radii" further down.
  panel: "4px"
  chip: "6px"
spacing:
  sm: "0.4rem"
  md: "0.8rem"
  lg: "1rem"
components:
  status-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    borderColor: "{colors.rule}"
    rounded: "{rounded.chip}"
---

# Design System: Amber Pay API Adaptor & Monitor System

## Overview

**Creative North Star: "Amber Daylight"**

The console is an operations board for the gateway⇄accounting link, read dark: an almost-black field carrying porcelain ink, held together by a persistent left sidebar. The four transit line-inks (scarlet, cobalt, amber, green) are spent only where they mean something — on connector routes and live service states — never as ornament. The first screen answers one question in five seconds: **where are payments sitting in the pipeline, and is that normal?**

**Key Characteristics:**
- An almost-black field (`#0a0e1a`) with slightly lighter surfaces (`#111827`) and hairline borders; the console is a dark operations room, not a paper window.
- Porcelain ink (`#f1f5f9`) for text; secondary and tertiary ink are held at ≥4.5:1 on the dark field.
- A persistent left sidebar (260px) groups navigation by Monitor / Operations / Administration / Account; every item is gate-hidden by the active policy scope.
- Operative readouts and references in IBM Plex Mono with tabular figures; labels in uppercase mono; body in IBM Plex Sans.
- Health and severity are separate vocabularies, and status is never signalled by colour alone: a text label and a shape mark always carry the state together.

## Operational vocabulary

The console names states with exactly two vocabularies, and never mixes them. `web/src/utils/vocabulary.ts` is the single translation point from the backend's wire values to operator language, so no surface invents its own wording.

**Health — what a connection is doing:**

| Health | Meaning | Tone |
|---|---|---|
| Healthy | Carrying traffic normally. | green |
| Degraded | Carrying traffic, behind its expected schedule. | amber |
| Failed | Not processing events; incoming traffic is queued. | red |
| Stopped | Disabled by configuration; no traffic expected. | neutral |
| Unknown | State not reported. | neutral |

**Severity — how much it matters:** Critical · Warning · Info.

The two are orthogonal: a connection is *Failed* (health) and the finding it raises is *Critical* (severity). Wire values `open / arriving / delayed / suspended` map to `healthy / healthy / degraded / failed`. Ambiguous terms the design deliberately avoids — "1 line suspended", "Live", "Open" as a health word — are replaced by the operational sentence ("1 accounting connection is not processing events").

## Flow-stage model

The Overview is organised around **payment flow**, not connection health. Connection health answers "are my integrations up?", which the sidebar already implies; flow answers the question that needs an operator. A payment passes through four stages, derived on the server from the domain's own lifecycle events (`server/src/services/flow/stageFlow.service.ts`) and delivered as an aggregate, never recomputed in the browser:

| Stage | Reached on | Target (warn) | Fail at |
|---|---|---|---|
| Initiated | `initiated` — payment created at the gateway | 30s | 5m |
| Collected | `collected` — funds collected | 1m | 10m |
| Ingested | `webhook-received` — webhook accepted by the adaptor | 1m | 10m |
| Posted | `record-updated` — invoice recorded in accounting | 5s | 30s |

`sync-change` is deliberately **not** a stage: it reports a cadence, not a position in the flow.

**Four rules the model must never break:**
1. **Silence is never health.** A stage that saw no traffic reports `not-reporting`, which renders as "Not reporting" with a dashed border — an affirmative statement that nothing was observed, not a green tick.
2. **The terminal stage is not a queue.** A posted payment has finished, so `posted` is excluded from "waiting" counts; counting it would inflate the blast radius permanently.
3. **Sampled counts say so.** The aggregate is derived from a capped event window. When `mayBeTruncated` is true the spine's caption states that the numbers are *sampled*, so a partial count is never presented as authoritative.
4. **The backend owns the numbers.** Thresholds are returned with the aggregate so the UI quotes the same figures the backend judged against. `web/src/utils/flow.ts` names and formats; it never recounts.

### The flow spine

`FlowSpine` is the Overview hero. It answers "where is it stuck, and how long has it been there" in one row per attribute:

- A real `<table>` — stages are columns, attributes (`State`, `Dwell p95`, `Flow`) are rows — so assistive tech announces each reading in context ("Dwell p95, Ingested, 2m 01s") and the bars stay decorative (`aria-hidden`).
- State is a **word** with a shape mark; colour is the second signal, never the only one.
- Each dwell bar is sized against its stage's own *fail* threshold and carries a tick where that stage's *target* sits. The reading is where the fill sits relative to the tick; a bar past the tick grows a diagonal hatch, because length has already hit the cap and "beyond normal" needs a different channel.
- Each stage's state cell is a single button drilling to `/events/<stage>`, which filters the log to exactly the event types that stage is computed from.
- Below 1024px the table scrolls horizontally inside its card with the row labels pinned, rather than being split into four cards that can no longer be compared.

### Telling blind from healthy

The Overview closes with the **service window** (`ServiceWindow`), a readout of the backend process itself: build, uptime, storage backend, event-window size, row counts, and adaptor reachability. Without it, "all healthy" and "the service stopped answering two hours ago" render identically — the console would re-display its last good snapshot as though it were current. When the status probe fails the panel switches to its `is-blind` variant and says the numbers are frozen, not healthy.

**The Connections page answers the same question from the same facts.** The service window and the connections list must never disagree about whether a route works, so both derive from the adaptors' own state: `connector_states` holds stored rows, and the dashboard payload merges the live adaptor state over them (`server/src/services/adaptors/connectorState.service.ts`) — a stored row for an adaptor's terminus is overlaid, and an adaptor with no stored row gets one. That second case is the live deployment: a Postgres install creates the table empty and nothing ever writes to it, so the Connections page listed **nothing at all** while the panel beside it knew the answer.

Two rules keep the merge honest. Reachability can only **downgrade** — a connected and reachable adaptor leaves a stored row's own operational status alone (the path may be degraded for its own reasons), while an unreachable one suspends it, because a path whose accounting system cannot be reached is carrying nothing. And the reason travels with it: the row's note carries the adaptor's own message ("QuickBooks is configured but not authorized: approve the connection in System configuration…") rather than a bare "unreachable", so the screen states the fix. The rows are shared, so the correction reaches the connection detail view, Synchronization's push/pull cards, the findings' affected connection, and the service map without any page forgetting to apply it.

## Colors

The palette is one near-black family carrying the field, with four transit line-inks and the health/severity accents spent on meaning.

### Field and surfaces
- **Ground** (`#0a0e1a`): the page ground.
- **Surface** (`#111827`): cards, tables, sidebar.
- **Raised** (`#1a2236`): hovers, selected surfaces, chips.
- **Bright** (`#1e293b`): elevated controls, active nav rail.

### Ink
An explicit four-step ramp. Each step is a deliberate, measured gap — not a shade picked by eye.

- **Ink 1** (`#f8fafc`) — *values and headings.* 16.6:1 on surface.
- **Ink 2** (`#cbd5e1`) — *body and prose.* 11.7:1.
- **Ink 3** (`#94a3b8`) — *meta, labels, thresholds.* 6.8:1.
- **Ink 4** (`#7c8ba0`) — *separators and disabled text only.* 5.1:1. **Never information.**

**The Threshold Rule.** The ramp was rebalanced because it had the emphasis backwards: real
supporting content — the threshold a reading is judged against, column heads, units — sat on the
*faintest* step at 5.12:1, so the things a reader most needs looked washed out while headings glowed.
Anything that carries information now sits at 6.8:1 or better, and the lowest step is reserved for
things that carry none. If you are reaching for ink 4 to render a label, the label belongs on ink 3.

- **Rule** (`#1e293b`): hairlines and control borders.

### Line inks (transit routes)
- **Scarlet** (`#d6403f`): the payment-push route.
- **Cobalt** (`#3c6fe0`): the scheduled-pull route.
- **Amber** (`#e6a12a`): the Sage bridge route.
- **Green** (`#39b98a`): the operational-event-stream route.

### Brand action colours
- **Primary (Amber)** (`#ef6000`): generic actions. Hover `#ff7a1a`; the text-safe variant `#ff8c33` is the focus ring.
- **On-primary** (`#1a1206`): the ink that sits *on* the brand amber. White on `#ef6000` measures **3.31:1** — the primary action on every page was failing WCAG AA outright, and a saturated orange fill carrying white text is also what "too bright" was describing. Dark ink on the same amber measures 5.6:1 and reads as a considered control rather than a glowing block. **Never put white text on `--primary`.**
- **Secondary (Mauve)** (`#bf7ab2`): restrained supporting emphasis — metadata glyphs. Text variant `#d49cc4`.

### Health and severity
- **Healthy** (`#39b98a`) · **Degraded** (`#fbbf24`) · **Failed** (`#f87171`), each on a soft tint.
- Severity reuses the same three accents; **Info** uses mauve.

**The One Voice Rule.** The four line-inks and the health/severity accents carry the whole system. No colour is decorative: every tint marks a connector route or a live state, and every tinted element also carries a label and a shape mark.

## Typography

**Sans:** Geist Variable (100–900 axis) with IBM Plex Sans and the platform sans as fallback.
**Mono:** Geist Mono Variable with IBM Plex Mono and the platform mono as fallback.

Both are variable, so emphasis can land on 500 or 550 rather than jumping 400 → 600. That middle
ground is the difference between a hierarchy and a shout: the previous sheet had almost no use of
anything between regular and semibold, which is a large part of why it read heavy.

**Why the change.** IBM Plex was replaced deliberately, not by drift. Plex is a fine face but it is
wide and its uppercase forms are chunky, so at the 10–12px sizes this console leans on, every label
came out heavy and layouts ran out of horizontal room before the content ran out. Geist has a taller
x-height and tighter apertures at small sizes, and is built for dark product UI. Nothing is
replaced that the system does not need: **one sans, one mono, no display face** — appropriate to an
Operate surface where scanability outranks expression. The entire world re-points by editing
`--font-sans` and `--font-mono`.

### The scale

Eight roles, and nothing else. The earlier sheet carried **29 ad-hoc sizes** (0.62rem through
1.05rem in 0.02rem steps); a type system with 29 steps is not a system.

| Role | Token | Size | Weight |
|---|---|---|---|
| Micro-label | `--fs-2xs` | 11px | 500–600, uppercase, `--ls-label` |
| Meta / caption | `--fs-xs` | 12px | 400 |
| Dense body, table cells, controls | `--fs-sm` | 13px | 400 / 600 |
| Body prose | `--fs-md` | 14px | 400 |
| Subhead, stage name | `--fs-lg` | 15px | 500–600 |
| Lead paragraph | `--fs-base` | 16px | 400 |
| Section title, hero reading | `--fs-xl` | 17px | 600 |
| Page title | `--fs-2xl` | 20px | 600 |
| **Verdict** | `--fs-3xl` | 24px | 600 |

**The 11px floor.** Nothing renders below 11px, and 11px is reserved for short uppercase labels.
Running text starts at 12px. The previous sheet had real information at 9.92px and 10.24px, which on
a dark field is not "subtle", it is unreadable.

**The Verdict Rule.** The most important sentence on a page is the largest thing on it. The flow
verdict is `--fs-3xl` (24px) and outranks the page title (`--fs-2xl`, 20px) — the reverse of the
earlier sheet, where the verdict was smaller than the chrome.

**Leading rises with measure, and dark needs more of it.** `--lh-tight` 1.25 for single-line data,
`--lh-snug` 1.4 for dense cells, `--lh-base` 1.5 for UI text, `--lh-prose` 1.65 for multi-line
prose. The flat 1.35 the sheet used everywhere was starving paragraphs of the extra leading that
light-on-dark text requires.

**The Tabular Rule.** Every count, reference, timestamp, and readout renders in Geist Mono with
`tabular-nums`, so numeric columns align down their runs. Mono is for code, data, and measurement —
not as costume for labels that merely look technical.

## Layout

The console is a persistent sidebar + content column. The sidebar (260px) groups navigation by function; the content column carries a sticky top bar (page title, data-mode tag, global search, last-updated stamp, refresh, notification bell, active policy scope selector, account) above a scrolling field.

**Space scale.** A 4px base — `--space-1` (2px) through `--space-10` (40px) — with semantic aliases
for the recurring roles (`--pad-card`, `--pad-control`, `--gap-inline`, `--gap-row`, `--gap-block`).
The sheet previously used **28 distinct spacing values** including 1.92px, 2.88px and 3.52px; those
are accidents, not a rhythm. Reach for a semantic alias before a raw step.

Pages are carded, and the Overview is ordered by operator priority: **flow verdict → flow spine →
what changed → attention required → backend service window → annotated activity**. Read that order
as the answer sequence: *what is wrong, where, is it getting worse, what do I do, can I trust this,
and what just happened.* The service map is a secondary experience reached from `/connections`; it
is never the hero.

**Responsive rules.** Structure changes, not just sizes. Wide data tables scroll inside their card
(`overflow-x-auto` on the card body) rather than pushing the page wider — a monitoring console legitimately has more
columns than a phone has room for, and clipping the fields that matter is worse than a scrolling
frame. Machine strings (webhook URLs) break with `wrap-anywhere`. The app bar's minimum
width is set by its children, so the scope selector and control gap tighten at ≤640px to keep the
longest page title on screen.

Routes: `/overview`, `/connections`, `/connections/:id`, `/findings`, `/findings/:id`, `/events`, `/events/:stage`, `/payments`, `/synchronization`, `/reconciliation`, `/users`, `/settings`, `/profile`, plus the unauthenticated `/signin` and `/invite/:token`. Routing is hash-based (`web/src/router.ts`), so every status is deep-linkable, an invite link is a shareable URL, and the browser back button works.

Responsive:
- **Desktop (>1024px):** persistent sidebar with full labels, wide content, four-across KPI row, two-column operational sections.
- **Tablet (721–1024px):** the sidebar collapses to a 76px icon rail; KPI and grid sections drop to one or two columns; the global search hides.
- **Mobile (≤720px):** the sidebar becomes an overlay drawer (restoring full labels) with a scrim and a hamburger in the header; KPI cards stack to one column; connection rows become stacked rows; the duplicate auth button hides because the avatar already opens profile/sign-in. The layout is single-column with no horizontal overflow.

## Authentication & onboarding

Access is invite-only and evaluated per request from policy attributes, never from a static role. The
auth surfaces live in `web/src/pages/auth/` (screens) and `web/src/components/auth/` (shared frame + icons), and share the console's tokens, so the door and the room are the
same building rather than two design languages meeting at a login screen.

**Entry rule.** A visitor with no session lands on **`/signin`**, not on a console full of synthetic
figures. Demo exploration still exists, but it is a deliberate choice offered *from* the sign-in page
("Explore with demo data instead") and it keeps the "Demo data" tag visible throughout. A monitoring
console that defaults to presenting fabricated numbers to someone expecting their own is the worst
failure mode it has. The attempted URL is preserved through sign-in, so a deep link survives the
round trip.

**Three surfaces, each answering a question the previous version left open:**

| Surface | Question it answers |
|---|---|
| `SignInPage` — credentials → second factor | Why two steps? The backend issues no token without 2FA, so the page says "step 1 of 2" up front instead of surprising the user with a second screen. |
| `InvitePage` — `/invite/:token` | What am I being granted, and what exactly is the password rule? Policy attributes are stated before the password is chosen, and the requirements resolve live as you type rather than being revealed on submit. |
| `DeniedPage` — a route the active scope cannot read | Which surface was refused, under which policy, and what single action could change it. |

**Authorization that is invisible is indistinguishable from authorization that is absent.** A route the
active scope cannot read previously redirected silently to the first readable route, which from the
user's side looks exactly like a broken link. The route is now held and rendered as a stated decision —
the URL is preserved, the policy attributes are quoted, and the nav still hides what the scope cannot
reach.

**Errors do not over-specify.** Sign-in failure says "That email and password combination was not
recognised" for both an unknown address and a wrong password, because a distinguishable message would
enumerate accounts — the UI must not undo a deliberate backend decision. An expired code says so and
offers a restart; a wrong code clears the field and returns focus.

**Known gap, stated in the UI rather than hidden:** there is no password-reset endpoint on the backend,
so no reset surface is offered. The sign-in page says access is granted by invitation and that this
build has no self-service reset, instead of shipping a link that cannot work.

## Elevation & Depth

Depth is a low soft lift, not shadow drama. `--shadow-soft` (0 2px 8px) sits under raised panels; `--shadow-panel` adds a 1px keyline. Cards sit near-flat on the ground. No hard offset shadow, no glow.

## Shapes

Small radius: 4px for cards, controls, and inputs (`rounded-panel`); 6px for chips and status pills (`rounded-chip`). Circular only for the avatar and the notification dot. There is no pill-shaped comfort beyond status chips.

> **Open decision — chip vs panel.** `rounded-chip` (6px) is now the *larger* of the two, so a status pill is rounder than the card holding it. The convention for a nested element is `inner ≤ outer`, and the previous pair (8px panel / 6px chip) satisfied it. Either resolve the chip to a value below the panel (`--radius-chip: 2px`, keeping two distinct tiers) or record here that the inversion is intentional. One knock-on: the stage-filter clear button is `rounded-[4px]` precisely because it is the concentric inner radius of a 6px chip — that value is derived from the chip, not from the panel, so it must move with any change to `--radius-chip`.

## Components

The reusable set lives in `web/src/components/ui.tsx`:

- **`HealthBadge`** — a connection's health (Healthy · Degraded · Failed · Stopped · Unknown) as a label + shape mark + tint. Never colour alone.
- **`SeverityBadge`** — Critical · Warning · Info, deliberately separate from health.
- **`ConnectionRow`** — one operational path: lamp, name/terminus, health badge, readout, note, and a chevron. The whole row is a single button that opens `/connections/:id`.
- **`FindingCard`** — an incident card carrying severity, reference, start time, problem, affected connector, operational impact, and the `View incident` / `Acknowledge` actions.
- **`MetricCard` / `Kpi`** — a compact readout with an optional 2px tone rail. `valueTone` lets a plain count stay neutral ink even when the card's rail is red (a "2 / 4" healthy count is not an alarm).
- **`Card`**, **`PageHeader`**, **`StaleNotice`**, **`SearchBox`**, **`Field`**.
- **States:** **`EmptyState`**, **`LoadingState`**, **`ErrorState`** — every data region has a designed empty, loading, and error form.
- **`PermissionGuard`** — renders the action when the active PBAC scope allows it, and a plain-language reason when it does not. Write actions are hidden rather than shown disabled, so the interface never offers a control the policy cannot honour.

### Tables
Lifecycle events and findings use the TanStack-backed `EventStream`; sortable headers, tabular mono numerals, and left-aligned timestamps. Health and severity render as badges, never raw status strings.

### Gateway hub service map
A radial hub diagram: Amber Pay's gateway sits at the centre of the plate and one straight spoke leaves it on a 45° diagonal for each connector, ending in a destination node. The spoke and node carry the route's **live state** — a solid green route when healthy, a dashed amber spoke with a dashed halo when degraded, a hatched node with a broken spoke when failed — so the plate answers *is it working?* at a glance, while the key underneath keeps the four line-inks as connector identity. Connectors that share a terminus are laid out as a pair, so one destination reached by two paths reads as a pair. Every node is a focusable button: activating one recedes the rest so a single route can be read alone, and each node writes its state as a word, never colour alone. Larger connector sets pull the ring in so no label leaves the plate; a failed spoke's pulse is suppressed under `prefers-reduced-motion`. `compact` renders the shortened Overview preview.

### Transactional email

Invitations, password resets, and verification codes are the only surfaces outside the console, and they belong to the same design system. They are rendered with Handlebars (`server/src/services/shared/email/`): `messages/*.hbs` carry copy, `partials/*.hbs` are the components, `styles.ts` holds every declaration and `theme.ts` every value — the tokens above, re-expressed as literals, because email clients strip stylesheets and ignore custom properties. The grammar is a console page's: a dark ground, a hairline card on a 560px measure, an uppercase mono eyebrow, a heading that outranks it, and exactly one amber action.

- **Tokens are mirrored, never invented.** `theme.ts` names the Tailwind token behind every value, because a drifting email palette fails silently — no build step can see inside an HTML string. Templates reach them with `{{token 'color.primary'}}`; a literal hex in a `.hbs` file fails a test.
- **Templates own no styling.** Every element draws its declarations from a named recipe (`{{styleAttr 'button.anchor'}}`), so styling cannot be re-decided inside markup.
- **The action is amber carrying `on-primary` ink.** White on `#ef6000` is 3.31:1; the rule travels with the brand, including into a recipient's inbox.
- **Mono carries readouts** — verification codes, expiry facts, references — with tabular figures, exactly as in the console. A code is the largest element in its message.
- **Tone is a label plus a 1px border**, never a wide coloured rail; the notice inks are the severity inks.
- **Copy is operational.** A message states what happened and what the recipient must do, quotes the same lifetime the backend enforces, and never implies an action that was not taken. Every message also ships a plain-text part.
- **Trap:** a `style="…"` attribute is delimited by double quotes, so a double-quoted font family ends the attribute early and silently discards every declaration after it (the button lost its ink and underline the first time). The font stacks in `theme.ts` are single-quoted, and the serialiser escapes the attribute as well.

## Navigation & access

Navigation is generated from the PBAC policy scope (FR-1.4). Each route declares the resource `scope` + `action` it needs:

- **Monitor** (Overview, Connections, Findings, Event log) — read on `dashboard`; acknowledging a finding requires `ack` on `dashboard`.
- **Operations** (Payments, Synchronization, Reconciliation) — read on `dashboard`/`payments`/`reports`; mutating actions require `write` on `payments`.
- **Administration** (Users, System configuration) — admin or write on `system`; hidden without it.
- **Account** (Profile) — always visible.

A super-admin policy (`scope: *` with `admin`) reveals every route and unlocks editing; a narrower scope collapses the navigation and sets mutate controls to read-only. The top-bar scope selector switches the active scope, and navigation plus control states re-evaluate immediately. If a scope switch hides the current route, the shell lands on the first route the policy can still read.

## Do's and Don'ts

### Do:
- **Do** spend colour only on connector routes and live states; the field stays near-black.
- **Do** render every count, reference, timestamp, and readout in mono with tabular figures.
- **Do** convey a state with a text label plus a shape mark (and a hatch on a failed line), never colour alone.
- **Do** keep health and severity separate, and route every wire value through `web/src/utils/vocabulary.ts` so no surface invents wording.
- **Do** describe what is operationally happening ("1 accounting connection is not processing events") rather than internal shorthand ("1 line suspended").
- **Do** keep the Overview ordered health → connections → findings → synchronisation → activity → topology, with the service map secondary.
- **Do** make every status drillable; a card that looks clickable is clickable.
- **Do** give every data region a designed empty, loading, and error state, and distinguish stale monitoring data from an unhealthy system.
- **Do** gate navigation and mutate controls by the active PBAC scope, not by a static role, and hide a write action the policy cannot honour rather than showing it disabled.
- **Do** label synthetic/demo data with the amber «Demo» tag wherever a visitor could mistake it for real data.

### Don't:
- **Don't** use a coloured left/right border wider than 1px on a card, list item, callout, or alert; carry tone with a lamp, label, and tint instead. (The KPI 2px rail is a standing component, not a per-card decoration.)
- **Don't** let the topology graph become the hero; it is a detail experience reached from the Overview and `/connections`.
- **Don't** reuse a light-field colour value on the dark field — the greens and reds are chosen per field.
- **Don't** paint a value with a tone that contradicts its words (a "2 / 4" healthy count does not go red because another connection failed; use `valueTone`).
- **Don't** add hard offset or glow shadows; depth is a soft lift.
- **Don't** put financial amounts, customer PII, or ledger figures anywhere in the console (FR-2.3 / FR-5.2) — the surface is operational events only.
- **Don't** introduce a display serif or a second wall; one sans + one mono carry the system.
- **Don't** invent a control the backend cannot serve; where a capability is missing (for example a manual-sync endpoint), say so plainly instead of reporting a success that cannot be verified.