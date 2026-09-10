// Sets placeholder env vars before any module import so the zod-validated
// env schema (which fails fast on missing required vars) can load in tests.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = 'postgres://placeholder:placeholder@localhost:5432/amber_pay';
process.env.JWT_SECRET = 'test-secret-placeholder-0123456789';
process.env.AMBER_PAY_WEBHOOK_SECRET = 'test-webhook-secret-placeholder';
process.env.QUICKBOOKS_CLIENT_ID = 'test-qb-client-id';
process.env.QUICKBOOKS_CLIENT_SECRET = 'test-qb-client-secret';
process.env.SAGE_CLIENT_ID = 'test-sage-client-id';
process.env.SAGE_CLIENT_SECRET = 'test-sage-client-secret';
