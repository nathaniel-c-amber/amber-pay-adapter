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
- **Email is templated with Handlebars in `services/shared/email/`**:
  `messages/*.hbs` (copy) + `partials/*.hbs` (components) + `styles.ts` (every
  declaration) + `theme.ts` (every value) + `engine.ts` (the Handlebars environment).
  A sender reads `env` and calls
  `emailService.sendTemplate(to, renderXEmail(props))` — `email/` reads no environment
  and builds no transport, and nothing outside `email/` builds markup.
  - **Every message needs both `messages/<name>.hbs` and `messages/<name>.text.hbs`**;
    the engine refuses to start without the pair. Its name must also appear in
    `SUBJECTS` (`templates.ts`), which owns the envelope.
  - Templates own **no styling**: declarations come from named recipes via
    `{{styleAttr 'name'}}` (a `SafeString`), so nothing can be double-escaped, and an
    unknown recipe throws rather than rendering an unstyled element. Values come from
    `{{token 'color.primary'}}`; a literal hex in a `.hbs` file fails a test.
  - Font families in `theme.ts` are **single-quoted**: they are inlined into a
    `style="…"` attribute, and a double quote would end it early, silently dropping
    every declaration after it.
  - The environment is `strict`, so a typo'd `{{headng}}` throws instead of rendering
    nothing. Optional partial params still work via `{{#if}}` / `default`.
  - `.hbs` files are not TypeScript, so `npm run build` copies them into `dist` via
    `scripts/copy-email-templates.mjs` (the `copy-migrations.mjs` precedent). The
    runtime image ships `dist` and no `src`.
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
