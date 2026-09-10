# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

From REQUIREMENTS.md (v2.0.0): React 19 with TypeScript and TanStack Table (frontend), Node.js 20 (Express) with TypeScript (backend, Modular Accounting Adaptor Interface), PostgreSQL 16 (operational logs, connection state, invite metadata — zero financial or customer PII), hosted on Amazon Web Services. Third-party integrations: Amber Pay (payment processing), QuickBooks & Sage APIs (accounting sync), Twilio SendGrid (email invitations). A frontend monitoring console is implemented in `src/`; the backend is not yet scaffolded.

## Users

Invite-only users of Amber Innovations' client organizations, working in finance/ops. Access is governed strictly by **Policy-Based Access Control (PBAC)** — no broad static roles (REQUIREMENTS.md v2.0.0 §1.3). Permissions are dynamically evaluated from user policy attributes and resource scope at every endpoint. API table (§5) still labels Admin / Super Admin / Accountant as coarse callers for the spec, but the authorization model is attribute-based policy, not fixed tiers.

## Product Purpose

Facilitate and monitor the bi-directional connection between the Amber Pay payment gateway and clients' accounting software (QuickBooks, Sage, extensible) through a modular connector architecture. Replaces manual reconciliation with a monitored, always-visible link. Success means the connection is healthy, events flow end-to-end, and critical failures are surfaced immediately — with zero financial or customer data ever stored or displayed.

## Positioning

A strictly-throughput monitoring layer: a backend service that adapts to any accounting software and a frontend monitoring console that keeps the gateway⇄accounting link visible in near real time. Built for Amber Innovations' client engagements needing gateway-to-accounting connectivity with a watched, auditable event trail.

## Operating Context

- Payments flow: invoice → payment link → customer checkout via Amber Pay → webhook → invoice status updated. The system stores no raw card data, no customer PII, and no ledger amounts — only operational event statuses and reference hashes (FR-2.3, FR-5.2).
- Accounting sync: completed payment events pushed to the active accounting adaptor ≤5 s (FR-3.2); scheduled sync status pull at configurable intervals (FR-3.3); manual syncs on demand. Connectors are modular (QuickBooks Online, Sage initially, extensible — FR-3.1).
- Monitoring: lifecycle events logged (transaction initiated, payment collected, record updated successfully, sync status change, webhook received — FR-5.1); critical failures (webhook processing errors, gateway disconnects) tracked and surfaced on the dashboard (FR-5.3).
- Webhook failure triggers on-call alerting via the deployment service.
- Access is invite-only with PBAC: dynamic policy evaluation, time-limited invites, email verification, 2FA, short-lived tokens. No static role tiers.

## Capabilities and Constraints

Confirmed from REQUIREMENTS.md (v2.0.0):

- Authentication: invitation-only account creation (no public registration); time-limited invite links; email verification; 2FA via email for all logins; short-lived access tokens (≤1 hr); PBAC — dynamic attribute policy evaluation for every endpoint, no static roles (FR-1.1–1.5).
- Payments & gateway adaptor: payment-link generation via Amber Pay; webhook-driven asynchronous state processing; MUST NOT store raw card data, customer PII, or financial ledger amounts — only operational event statuses and reference hashes (FR-2.1–2.3).
- Accounting sync: extensible Adaptor interface (QuickBooks Online + Sage initially, FR-3.1); push completed payment events ≤5 s (FR-3.2); scheduled sync status pull at configurable intervals (FR-3.3).
- Monitoring & event logging: lifecycle events logged (transaction initiated, payment collected, record updated successfully, sync status change, webhook received, FR-5.1); NO financial or customer data in log payloads (FR-5.2); critical failures tracked and surfaced on the monitoring dashboard (FR-5.3).
- Dashboards: real-time connection health, sync-loop status, and the lifecycle event stream. No monetary or customer figures are displayed. Exportable reports remain possible at the API level without exposing PII in the console.
- Access control and API roles per §5 API specification. Data model defined in §6 (User, Account, Invoice, Payment, ReconciliationJob).
- Testing: Jest (frontend) and Jest/SuperTest (backend), Cypress (E2E), Postman (API contracts). CI/CD via GitLab + AWS (VPC, RDS, ECS, IAM, Secrets Manager).

Explicitly undecided: none confirmed beyond the requirements doc; treat anything not in REQUIREMENTS.md as not yet decided.

## Brand Commitments

Product name: **Amber Pay API Adaptor & Monitor System** (v2.0.0 required a monitoring console, not a reconciliation ledger). Owner: Amber Innovations Ltd. No logo or style assets have been provided. The visual world is the Midnight Transit Diagonal (network service-map, see DESIGN.md).

## Evidence on Hand

- REQUIREMENTS.md at project root (v2.0.0, 2026-09-09): purpose, objectives, PBAC access model, tech stack, functional requirements (FR-1.1 through FR-5.3), API spec, data model, testing strategy, deployment, user journeys, milestones.
- `src/` implements the frontend monitoring console (dashboard surface) in the Midnight Transit Diagonal world.
- No design assets, mockups, testimonials, or customer references exist yet. Future work must not fabricate testimonials, customers, pricing, or deployment claims, and must not place financial or customer data in any display or log.

## Product Principles

- Health-first: the console exists to make the gateway⇄accounting connection legible; every connector state and every lifecycle event must be visible and auditable.
- Privacy is absolute: no financial amounts, no customer PII, no raw card data, no ledger figures — in any surface or any log.
- PBAC over roles: access is attribute-policy driven, never a static role tier; each session shows exactly the scope it holds.
- Near-real-time by default: push within seconds, scheduled pull, clear alerting when either fails.
- One source of truth: gateway, accounting system, and the event log must agree, with failures surfaced rather than papered over.

## Accessibility & Inclusion

No product-specific accessibility or inclusion requirement has been established beyond delivering web UI to finance staff.