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
| `utils/` | Pure helpers (`errors`, `logger`, `logFile`, `tokens`, `passwords`, `pbac`, `duration`, `policyScopes`, `policyResource`). |
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
- **Logging is stdout PLUS an optional rotating file** (`utils/logger.ts` fans out via
  `pino.multistream`; `utils/logFile.ts` is the dependency-free file sink). `LOG_TO_FILE`
  (default true), `LOG_DIR`, `LOG_FILE_NAME`, `LOG_MAX_SIZE_BYTES`, `LOG_MAX_FILES`.
  Three rules the next change must keep:
  - The file sink is **off under `NODE_ENV=test`**, always. A test run must not write log
    files, and its own console output is the thing to read.
  - `write()` **never throws**: it is a pino destination, so an escaping exception would
    either drop an unrelated log line or (as a stream `error` event) kill the process.
    An unwritable directory is reported once on stderr and downgraded to stdout-only.
  - Writes are **synchronous** on purpose, so rotation cannot race an in-flight write —
    the lines you need most are the ones written just before a crash.
- **Lifecycle events are the system of record, so anything observable must reach them.**
  `services/events/adaptorEventRecorder.service.ts` files adaptor state CHANGES (not polls:
  the console polls every 10s) as `adaptor-*` events plus a finding; `services/adaptors/*`
  reports a structured `AdaptorFailureReason` rather than only a message.
  - A new `LifecycleEventType` needs **four** edits, not one: `models/domain.ts`,
    `db/migrations/*.sql` (the `type` CHECK constraint — Postgres rejects the insert
    otherwise), and the frontend `types/api.ts` + `types/domain.ts` unions with their
    `EVENT_LABEL` / `EVENT_ORDER` / `EVENT_FLOW_NOTE` `Record`s.
  - `EventRepository.list` returns **newest-first by timestamp**, and two events written in
    the same millisecond keep insertion order — so never assert on the order of a
    multi-event list; compare sorted values.
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
