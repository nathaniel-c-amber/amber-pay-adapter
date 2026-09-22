# AGENTS.md

Project-specific guidance for AI coding agents working in `server/`.

<!-- STRUCTURE:START -->
`server/src/` is layered by **technical responsibility**. A layer may depend on
the layers below it, never above it (`services` must not import `controllers`).

| Layer | Holds |
| --- | --- |
| `routes/` | Express `Router` factories only: path, middleware, authorization policy, throttling. No business logic, no request parsing. |
| `controllers/` | Request handling: validate input, call a service/repository, shape the response. Exported as `createXController(deps)` factories so the DI seams survive. |
| `services/` | Business logic — `services/auth`, `services/payments`, `services/adaptors`, `services/gateway`, `services/events`, `services/webhooks`, `services/flow`, `services/shared`. |
| `repositories/` | Data access. Contracts live in `types/repository.ts`; `inMemory.ts` and `postgres.ts` implement them. |
| `models/` | Domain entities (`domain.ts`). |
| `types/` | Shared contract types (`auth`, `adaptor`, `gateway`, `repository`). |
| `middleware/` | Cross-cutting Express middleware (`auth.middleware`, `asyncHandler`, `errorHandler`). |
| `utils/` | Pure helpers (`errors`, `logger`, `tokens`, `passwords`, `pbac`, `duration`, `policyScopes`, `policyResource`). |
| `db/` | Pool, migrator, seed, `migrations/*.sql`. |
| `config/` | Environment parsing (`env.ts`). |

## Conventions

- **ESM + NodeNext**: every relative import ends in `.js`, even from a `.ts` source file.
  Path aliases are deliberately NOT used here — `tsc` does not rewrite `paths` in
  emitted JavaScript, so aliases would break `node dist/server.js`.
- **Mount order matters**: `app.ts` mounts routers under `/api/v1`. The webhook
  router MUST be mounted BEFORE `express.json()`, because it verifies a signature
  over the raw request body.
- **Tests are colocated** (`*.test.ts`); jest `roots` is `src` and `setupFiles` is
  `src/test/setup-env.cjs`.
- **Privacy**: `models/domain.ts` documents the rule — no amounts, no currency, no
  customer PII, no ledger figures. `models/privacy.test.ts` enforces it.
<!-- STRUCTURE:END -->

## Build / test

```bash
npm run typecheck   # tsc --noEmit
npx jest            # full suite
npm run build       # tsc + scripts/copy-migrations.mjs
```

`scripts/copy-migrations.mjs` copies `src/db/migrations` → `dist/db/migrations`;
`src/db/migrator.ts` resolves the compiled copy first. Moving either directory
means updating both.
