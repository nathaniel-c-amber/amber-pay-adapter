# Amber Pay Ledger — Payment Monitor & Reconciler

Operational monitoring for the Amber Pay gateway and its accounting adaptors
(QuickBooks, Sage). Backend API + monitoring dashboard.

## Stack

- **Backend** (`server/`) — Express + TypeScript (ESM, NodeNext), PostgreSQL 16,
  PBAC auth, webhook pipeline. Node 20.
- **Frontend** (`web/`) — React 19 + Vite + TypeScript + TanStack Table.
- **Deployment** — Docker Compose (PostgreSQL 16, backend Node 20, frontend nginx).

## Repository layout

- `server/` — backend API (Express + TypeScript). Layered by technical
  responsibility: `routes/` → `controllers/` → `services/` → `repositories/`,
  with `models/` (domain entities), `types/`, `middleware/`, `utils/`, `db/`
  and `config/` alongside. See `server/AGENTS.md`.
- `web/` — frontend monitoring console (React + Vite). Grouped by type:
  `pages/`, `components/`, `services/`, `types/`, `utils/`, `styles/`. See
  `web/AGENTS.md`.

Both are TypeScript with a single-direction dependency rule: a layer may depend
on the layers below it, never above it (a `service` must not import a
`controller`; a `component` must not import a `page`).

## Prerequisites

- Docker (with Docker Compose v2).

## Run the full stack

```bash
# 1. Configure secrets (copy and fill in real values; never commit them)
cp .env.example .env

# 2. Build and start all services
docker compose up --build
```

Services and ports:


| Service | Port (host) | Notes                                 |
| --------- | ------------- | --------------------------------------- |
| `web`   | `8080`      | Frontend SPA (nginx)                  |
| `api`   | `3300`      | Backend API (`/health`, `/api/v1/*`)  |
| `db`    | `5432`      | PostgreSQL 16 (internal to the stack) |

The `api` service runs migrations on startup and waits for `db` to be healthy.
PostgreSQL data persists in the `db-data` volume.

## Testing across the internet (ngrok)

The stack ships an opt-in `ngrok` service that publishes the app on a public
HTTPS URL. It tunnels the `web` service (nginx), which already proxies `/api`
to `api`, so a single URL serves both the SPA and the API.

```bash
# 1. Add your token to .env (https://dashboard.ngrok.com/get-started/your-authtoken)
#    NGROK_AUTHTOKEN=...
#    NGROK_DOMAIN=            # optional reserved/static domain

# 2. Start the stack with the tunnel profile
docker compose --profile tunnel up --build
```

- The public URL is printed in the `ngrok` logs and shown at
  [http://localhost:4040](http://localhost:4040) (ngrok's local inspector).
- Without `NGROK_DOMAIN`, ngrok assigns a random ephemeral URL that changes on
  every restart. Set `NGROK_DOMAIN` to a reserved domain for a stable URL.
- The tunnel is opt-in: a plain `docker compose up` stays local and never
  exposes the stack.

**Point the app at the public URL.** Once you know the URL, set these in `.env`
and restart so CORS, invite links, and 2FA links use it:

```bash
CORS_ORIGINS=https://<your-subdomain>.ngrok-free.app
APP_BASE_URL=https://<your-subdomain>.ngrok-free.app
```

> The ngrok free tier shows a browser interstitial on first visit. Send the
> `ngrok-skip-browser-warning` header (or use a paid plan) to bypass it for
> automated/API testing.

## Environment / secrets

docker-compose reads a root `.env` file automatically. Required vars:

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `JWT_SECRET` (>= 16 chars)
- `CORS_ORIGINS` (the frontend origin, e.g. `http://localhost:8080`)
- `AMBER_PAY_WEBHOOK_SECRET`

Optional: `AMBER_PAY_*`, `QUICKBOOKS_*`, `SAGE_*`, `SMTP_*`, `APP_BASE_URL`.
Runtime mode: `NODE_ENV` (default `production`).
Logging: `LOG_LEVEL`, `LOG_TO_FILE`, `LOG_DIR`, `LOG_FILE_NAME`,
`LOG_MAX_SIZE_BYTES`, `LOG_MAX_FILES`.
For internet testing, `NGROK_AUTHTOKEN` and (optionally) `NGROK_DOMAIN`.
See `.env.example` for the full list. **Never commit real secrets.**

### Development mode and the 2FA code

`NODE_ENV` selects the runtime mode of the `api` service. Under `development`
the API returns the 2FA code — and invite and password-reset tokens — in its
responses, so the sign-in flow can be completed without a mailbox; the console
fills the code into the form for you. Set it in `.env` and recreate the
container:

```bash
NODE_ENV=development
docker compose up -d
```

Those values are credentials. Keep `development` for machines only you can
reach; anything shared or public stays on `production` (the default), where the
server emails the code and never returns it.

### Connecting QuickBooks

`QUICKBOOKS_CLIENT_ID` / `_SECRET` identify the app; they do **not** authorize a
call. QuickBooks needs a bearer token, so set one of:

- `QUICKBOOKS_ACCESS_TOKEN` — used as-is (Intuit issues these for ~1 hour), or
- `QUICKBOOKS_REFRESH_TOKEN` — exchanged at Intuit's token endpoint on connect,
  and re-exchanged automatically when an access token expires mid-run.

Also set `QUICKBOOKS_REALM_ID` (the company id) and, for a sandbox company,
`QUICKBOOKS_BASE_URL=https://sandbox-quickbooks.api.intuit.com`.

The API connects every configured adaptor at startup and logs one line per
adaptor — check it with `docker compose logs api | grep -i adaptor`. The console's
**Backend service** panel reports the same state, and when an adaptor cannot
connect it states the reason (missing credentials vs. missing grant vs. an
upstream status) rather than a bare "not connected".

Adaptor state also lands in the **Event log**: a connection that starts failing
(rejected credentials and unreachable are recorded as different types, because
they need different remedies), a failure whose reason changes, and a recovery.
Only state *changes* are recorded — the console polls every few seconds and
logging each poll would bury the incident in its own repetition.

### Logs

The API writes every line to stdout **and** to a rotating file, so the log
outlives the container:

- `LOG_LEVEL` applies to both sinks.
- `LOG_TO_FILE` (default `true`), `LOG_DIR` (the compose stack uses
  `/app/logs`, backed by the `api-logs` volume), `LOG_FILE_NAME`
  (default `server.log`), `LOG_MAX_SIZE_BYTES` (5 MiB) and `LOG_MAX_FILES` (5).

```bash
docker compose exec api tail -f /app/logs/server.log    # live
docker compose exec api cat /app/logs/server.log.1      # the previous file
```

If the log directory cannot be written, the API says so once on stderr and
continues with stdout-only logging — a log sink must never stop the API it is
observing, and tests never write log files.

## Development (without Docker)

Backend:

```bash
cd server
cp .env.example .env   # set DATABASE_URL, JWT_SECRET, etc.
npm install
npm run dev            # tsx watch, port 3300
```

Frontend:

```bash
cd web
npm install
npm run dev            # Vite dev server, port 5173
```

Build the frontend (outputs to `web/dist/`):

```bash
cd web
npm run build
```

## Notes

- The frontend is **wired to the backend API**: it authenticates via the login
  gate (email + password + email 2FA), then polls `/api/v1/dashboard/metrics`
  every 15s for live connector states, lifecycle events, and findings.
  Acknowledging a finding persists via `POST /api/v1/failures/:id/acknowledge`.
- In development, the Vite server proxies `/api` to the backend at `:3300`; in
  the Docker stack, nginx proxies `/api` to the `api` service.
- Backend tests run without a live DB (in-memory repositories); Postgres
  integration tests are skipped unless a real `DATABASE_URL` is configured.
