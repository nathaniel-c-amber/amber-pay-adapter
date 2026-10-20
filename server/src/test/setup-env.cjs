// Sets placeholder env vars before any module import so the zod-validated
// env schema (which fails fast on missing required vars) can load in tests.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// Respect a DATABASE_URL the caller supplied, so the integration suite can run
// against a real Postgres (`docker compose up -d db`, then export DATABASE_URL).
// The placeholder exists so the zod-validated env schema can load without one —
// it must not OVERWRITE a real one, because that made
// `postgres.integration.test.ts` skip unconditionally and its "is a database
// configured?" guard unable to ever answer yes.
process.env.DATABASE_URL ??= 'postgres://placeholder:placeholder@localhost:5432/amber_pay';
process.env.JWT_SECRET = 'test-secret-placeholder-0123456789';
process.env.AMBER_PAY_WEBHOOK_SECRET = 'test-webhook-secret-placeholder';
// The merchant account the gateway issues per project and environment. It goes
// into every signature request, so a checkout cannot be created without it —
// which is exactly why the schema requires it rather than defaulting.
process.env.AMBER_PAY_CLIENT_ID = 'test-amber-client-id';
// Bearer token for OUTBOUND gateway calls. Never sent to the browser.
process.env.AMBER_PAY_API_TOKEN = 'test-amber-api-token';
process.env.QUICKBOOKS_CLIENT_ID = 'test-qb-client-id';
process.env.QUICKBOOKS_CLIENT_SECRET = 'test-qb-client-secret';
// A bearer token (or refresh token) is what authorizes a call; client id/secret
// alone cannot mint one, so `connect()` requires one of these to succeed.
process.env.QUICKBOOKS_ACCESS_TOKEN = 'test-qb-access-token';
process.env.QUICKBOOKS_REFRESH_TOKEN = 'test-qb-refresh-token';
process.env.SAGE_CLIENT_ID = 'test-sage-client-id';
process.env.SAGE_CLIENT_SECRET = 'test-sage-client-secret';
// The single organization this deployment serves. Tests use 'org-1' throughout,
// so the default has to match it or every grant would be refused as foreign.
process.env.ORGANIZATION_ID = 'org-1';
// Credential sealing. TWO keys on purpose, with the current at version 2: the
// rotation path (reading a value sealed under the previous key) is the part of
// an encryption scheme that only fails the first time somebody rotates, so the
// suite exercises a real older envelope rather than asserting a branch exists.
// Not real keys: they exist only for the in-process suite.
process.env.SECRETS_KEY = 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4';
process.env.SECRETS_KEY_VERSION = '2';
process.env.SECRETS_KEY_PREVIOUS =
  '0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c0f1e2d3c';
