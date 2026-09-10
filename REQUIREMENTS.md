# Requirements

## 1. Project Overview

- **Project Name:** Amber Pay API Adaptor & Monitor System
- **Version:** 2.0.0
- **Date:** 2026-09-09
- **Team:** Amber Innovations Ltd.

### 1.1 Purpose & Scope

The system is a strictly backend service with a frontend monitoring system. Its sole purpose is to facilitate the connection between accounting software (adaptable to any accounting software, starting with QuickBooks and Sage) and the payment gateway, and to monitor the connection between the two.

### 1.2 Key Objectives & Benefits

- **Adaptable Accounting Integration:** Modular connector architecture supporting QuickBooks, Sage, and extensible to other accounting platforms.
- **Strict Privacy & Zero Data Storage:** **No financial or customer data should be recorded or stored.** The system only logs operational lifecycle events (transaction initiated, payment collected, record updated successfully, webhook processed).
- **Secure PBAC Access:** Invite-only user authentication and strictly Policy-Based Access Control (PBAC).
- **Operational Monitoring:** Real-time visibility into connection health, sync loops, and event logs.

### 1.3 Target Audience & User Roles

- **Invite-Only Users (PBAC):** Access rights are governed strictly by fine-grained policies assigned upon invite acceptance. No broad static roles; permissions are dynamically evaluated based on user policy attributes and resource scope.

---

## 2. Technical Stack & Architecture

- **Frontend:** React 19 with TypeScript, TanStack Table
- **Backend:** Node.js 20 (Express) with TypeScript, Modular Accounting Adaptor Interface
- **Database:** PostgreSQL 16 (Operational logs, connection state, invite metadata — **zero financial or customer PII storage**)
- **Infrastructure/Hosting:** Amazon Web Services
- **Third‑Party APIs/Services:** Amber Pay for payment processing, QuickBooks & Sage APIs for accounting sync, Twilio SendGrid for email invitations.

---

## 3. Functional Requirements

### 3.1 Authentication & Authorization (PBAC + Invite-Only)

- **FR-1.1:** User accounts **MUST** be created via invitation only; public self-registration is strictly prohibited.
- **FR-1.2:** Authorized administrators **MUST** be able to invite users by email with specific policy attributes attached.
- **FR-1.3:** Invited users **MUST** complete account setup via a time-limited invitation link.
- **FR-1.4:** Access control **MUST** be strictly Policy-Based Access Control (PBAC), evaluating dynamic attribute policies for every endpoint access.
- **FR-1.5:** Access tokens **MUST** be short-lived (≤1 hr).

### 3.2 Payment & Gateway Adaptor

- **FR-2.1:** The system **MUST** facilitate payment link generation via Amber Pay.
- **FR-2.2:** Webhooks **MUST** trigger asynchronous processing of payment state changes.
- **FR-2.3:** **CRITICAL SAFETY:** The system **MUST NOT** store raw credit-card data, customer PII, or financial ledger amounts. Only operational event statuses and reference hashes are recorded.

### 3.3 Modular Accounting Synchronization

- **FR-3.1:** The system **MUST** provide an extensible Accounting Adaptor interface supporting QuickBooks Online and Sage initially.
- **FR-3.2:** Completed payment events **MUST** be pushed to the active accounting software adaptor within 5 seconds.
- **FR-3.3:** Scheduled synchronization **MUST** pull sync status updates at configurable intervals.

### 3.4 Monitoring & Event Logging

- **FR-5.1:** The system **MUST** log lifecycle events (transaction initiated, payment collected, record updated successfully, sync status change, webhook received).
- **FR-5.2:** **NO FINANCIAL OR CUSTOMER DATA** shall be present in log payloads.
- **FR-5.3:** Critical failures (e.g., webhook processing errors, gateway disconnects) **MUST** be tracked and surfaced on the monitoring dashboard.

## 5. API Specification (High‑Level)


| Method | Endpoint                         | Description                      | Auth Role          |
| -------- | ---------------------------------- | ---------------------------------- | -------------------- |
| POST   | `/api/v1/auth/invite`            | Invite a user by email           | Admin, Super Admin |
| POST   | `/api/v1/auth/accept-invite`     | Accept invite & set up account   | Public (token)     |
| POST   | `/api/v1/auth/login`             | Authenticate and obtain JWT      | Public             |
| POST   | `/api/v1/auth/2fa/verify`        | Verify email 2FA code            | Public             |
| GET    | `/api/v1/payments/:id`           | Retrieve payment details         | Admin, Super Admin |
| POST   | `/api/v1/payments`               | Create payment link              | Admin, Super Admin |
| GET    | `/api/v1/reports/reconciliation` | Reconciliation report            | Accountant         |
| GET    | `/api/v1/dashboard/metrics`      | Real‑time metrics for dashboard | Admin, Super Admin |

## 6. Data Model Overview

- **User** – id, email, hashed_password, role, created_at, updated_at
- **Account** – id, name, organization_id, created_at, updated_at
- **Invoice** – id, account_id, external_invoice_id (QuickBooks), amount, currency, status, due_date
- **Payment** – id, invoice_id, transaction_id, amount, status, processed_at
- **ReconciliationJob** – id, run_at, status, summary_json

## 7. Testing Strategy

- **Unit Tests:** Jest (frontend) and Jest with SuperTest (backend)
- **Integration Tests:** End‑to‑end tests using Cypress for UI flows; Postman collection for API contracts.

## 8. Deployment & CI/CD

- **Repository:** GitLab (main branch protected, PR reviews required).
- **Infrastructure as Code:** Amazon Web Services (VPC, RDS, ECS, IAM, Secrets Manager).

## 9. User Journeys / Workflows

**\[User Action\] ---> \[System Event\] ---> \[Expected Outcome\]**

- Admin invites user by email ---> Invitation link sent ---> User sets up account and verifies email
- Admin requests payment link ---> Link generated via Amber Pay ---> Sent to customer
- Customer completes checkout ---> Amber Pay triggers webhook ---> Invoice status updated
- Payment declined ---> Failure webhook received ---> Invoice stays outstanding, Admin notified
- Payment confirmed ---> Pushed to QuickBooks (≤5s) ---> QB invoice marked paid
- Sync interval elapses ---> Invoices/customers pulled from QuickBooks ---> Local records updated
- Admin triggers manual sync ---> On-demand QuickBooks pull ---> Sync status shown on dashboard
- Reconciliation job runs ---> Transactions compared vs QuickBooks ---> Mismatches queued
- Mismatch detected ---> Accountant alerted ---> Discrepancy reviewed and resolved
- Webhook fails critically ---> Error logged & tracked ---> On-call team alerted

---

## 10. Milestones & Deliverables


| Phase   | Milestone                    | Expected Completion |
| :-------- | :----------------------------- | :-------------------- |
| Phase 1 | Minimum Viable Product (MVP) | 3 Weeks             |
| Phase 2 | Beta Testing & Bug Fixes     | 2 Weeks             |
| Phase 3 | Production Launch (v1.0)     | 1 Week              |

---
