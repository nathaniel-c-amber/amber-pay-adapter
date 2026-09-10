// Sets placeholder env vars before any module import so the zod-validated
// env schema (which fails fast on missing required vars) can load in tests.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = 'postgres://placeholder:placeholder@localhost:5432/amber_pay';
process.env.JWT_SECRET = 'test-secret-placeholder-0123456789';
process.env.AMBER_PAY_WEBHOOK_SECRET = 'test-webhook-secret-placeholder';
