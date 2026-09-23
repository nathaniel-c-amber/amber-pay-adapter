---
version: 1
slug: "dashboard"
primary_target: "dashboard"
related_targets: []
---

# Dashboard surface brief

## Scope and visitor mode

- **Surface:** The core operational console for the Amber Pay API Adaptor & Monitor System — the real-time monitoring dashboard for the gateways⇄accounting-adaptor link (connection health, sync loops, lifecycle event log, critical-failure surfacing; see REQUIREMENTS.md v2.0.0 §1.1, §3.2–3.4, §5 API, §6 model).
- **Mode:** Operate. Scanability, consistency, native expectations, and the real usage scene (finance/ops staff and the on-call engineer watching whether the machine is healthy) outrank expression.
- **Audience / job:** Invite-only PBAC-governed users. Job: see the health of every connector (Amber Pay → accounting adaptor) at a glance, follow the sync loop, catch a critical failure the moment it happens, and read the lifecycle event stream — with zero financial or customer data anywhere.
- **Proof / content:** Adaptor-connection health, live service state per line, sync-loop status, the lifecycle event log (FR-5.1), active critical failures (FR-5.3). No amounts, no customer PII, no ledger figures. Label demonstration data synthetic where a visitor could mistake it for real data.
- **Constraints:** PBAC (no static roles; a policy-scope indicator, not a role dropdown), short-lived tokens (≤1 hr), invite-only, zero financial/customer data storage or display, audit trail, WCAG 2.2 AA, keyboard navigable, responsive (desktop-first ops view, usable on mobile), the adaptor connection and the sync loop are the center of gravity.

## Direction contract

**THESIS:** This console is the operating network made legible as a service map: every connector between Amber Pay and an accounting adaptor is a coloured line on a midnight-enamel board, and its live service state is what you read first. It refuses the KPI-card-grid "monitor wallpaper" that shows all is well — this surface is about the moment a line is suspended and an operator must see which route broke.

**OWN-WORLD:** Midnight-blue enamel ground with porcelain-white station ticks; scarlet, cobalt, amber and green line inks on one diagram, the active line burning brightest and the others receding. Lines bend only at 45° and 90°, interchange circles bloom where routes cross, and each connector's segment carries a live service state (open / arriving / delayed / suspended). A humanist transit sans rules labels at a fixed size; every operational readout and reference is monospaced. Status is never colour alone: each state renders a text label plus a shape mark (and a hatch texture for the suspended state).

**STORY:** An operator opens the board and one question is answered on sight: is each connector between Amber Pay and QuickBooks/Sage open, delayed, or suspended? They follow the sync loop around the diagram, read the lifecycle event stream, and acknowledge a critical failure — every action leaving a visible tick, like a signal thrown in the box.

**FIRST VIEWPORT:** A top rebate: a header row with the running overall status ("All lines open" / "N lines suspended") and an "as of" stamp plus the policy-scope indicator. Below, the monitoring board: a large midnight-enamel service map of the connectors (Amber Pay at the centre as the gateway hub, QuickBooks and Sage as adaptor termini, lines routing between them with interchange circles), each line lit by its live state, the active/focused line burning brightest with its segment ticks. Beneath it, the lifecycle event stream (FR-5.1) ruled as a wall of stamped entries. A pinned right-hand column lists critical failures, each staying lit until acknowledged. Signature interaction: focus a line on the diagram by hotkey/click, it burns brightest and its segment states magnify to vertex reads.

**FORM:** The chosen form is the Midnight Transit Diagonal, the winning challenger (SOURCE ID wayfinding-cartography-signage-midnight-transit-diagram) fused over the assigned Relay Room roll (seed key ca7932b5). Raised by the challengers it beat: the Signal Box's throw-the-route alive control (the focused line burns as you move between it) and the Relay Room's stamped message-tape event log (each lifecycle event arrives as a stamped entry). Breaks the grid-rut: hard geometric 45/90 line discipline, never a rounded-utility-card layout.

## Direction contract

**THESIS:** This console is the operating network read on a light, porcelain operations board: the health of every connector between Amber Pay and an accounting adaptor is answered on first sight, and every other surface (transactions, alerts, config, users, profile) is one navigation step behind a carded grid. It refuses the dark-theme operator-monitor default and the single-page KPI-wall; this is a multi-page surface whose navigation itself enforces policy.

**OWN-WORLD:** A fixed sidebar (Monitor / Operations / Administration / Account) on a porcelain field, white carded panels with hairline rules, midnight ink, and the four line-inks darkened to hold 4.5:1 on light. Scarlet/cobalt/amber/green are spent only on connector routes and service states. Status renders a text label plus a shape mark (and a hatch on the suspended line) — never colour alone. Every readout is monospaced with tabular figures.

**STORY:** An operator signs in under a policy scope and opens Health & status: overall connection health answered, four operational readouts, a connector health list, a compact findings panel, the signature service map, and the lifecycle stream. The scope selector in the top rebate re-shapes the whole console — narrower scopes collapse the navigation and drop acknowledge/edit to read-only; a super-admin scope reveals System configuration and Users.

**FIRST VIEWPORT:** Fixed sidebar with grouped navigation and the live alerts count. Top rebate: page title, data-mode tag (Live / Demo), "as of" stamp, active scope selector, sign-in/refresh. Content: a health hero (status ring + overall verdict), a four-tile KPI strip, connector health | open findings cards, the service map, and the lifecycle event stream. Synthetic demonstration data is amber-tagged Demo wherever it could be mistaken for live.

**FORM:** The chosen form is a light multi-page operations console (SalesOps-style sidebar + KPI + card surfaces), user-pinned as the redesign direction and re-inked into the Amber line palette. Replaces the prior single-surface Midnight Transit Diagonal dark world; the service map is retained and re-themed as the signature plate.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Unresolved

- Which further accounting softwares to diagram once the MVP ships (Sage is in scope; add-ons live as additional termini on the board).
- Whether audit-action events stream here or live on a separate Audit surface (FR-5.1); the console shows the lifecycle event stream, the dedicated surface is future work.
