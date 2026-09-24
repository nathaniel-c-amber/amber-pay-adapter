/**
 * Route barrel — the HTTP surface of the API, mounted under `/api/v1` in
 * `app.ts`. Routers declare paths, authorization policy and throttling; the
 * request handling itself lives in `controllers/`.
 */
export { createAuthRouter } from './auth.js';
export { createDashboardRouter } from './dashboard.js';
export { createFailuresRouter } from './failures.js';
export { createPaymentRouter } from './payments.js';
export { createReportRouter } from './reports.js';
export { createServiceRouter } from './service.js';
export { createSettingsRouter } from './settings.js';
export { createUsersRouter } from './users.js';
export { createWebhookRouter } from './webhooks.js';

export type { AuthRouteDeps } from './auth.js';
export type { DashboardRouteDeps } from './dashboard.js';
export type { FailuresRouteDeps } from './failures.js';
export type { PaymentRouteDeps } from './payments.js';
export type { ReportRouteDeps } from './reports.js';
export type { SettingsRouteDeps } from './settings.js';
export type { UsersRouteDeps } from './users.js';
