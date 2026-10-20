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
| `db`    | `15432`     | PostgreSQL 16 (host loopback; internal to the stack on 5432) |

The `api` service runs migrations on startup and waits for `db` to be healthy.
PostgreSQL data persists in the `db-data` volume.

## Testing across the internet (Cloudflare Tunnel)

The stack ships an opt-in `cloudflared` service that publishes the app on a
public HTTPS URL. It tunnels the `web` service (nginx), which already proxies
`/api` to `api`, so a single URL serves both the SPA and the API.

Cloudflare Tunnel is also the better choice on a network that inspects TLS
(Zscaler and similar). The origin leg is a connection to `web` on the compose
network, so there is no re-signed origin certificate for the container to
trust, which is the failure that makes `ngrok` unusable on such networks.

```bash
# 1. Create a tunnel at Zero Trust -> Networks -> Tunnels, choose the Docker
#    connector, and copy the token it prints. Then add it to .env:
#    CLOUDFLARE_TUNNEL_TOKEN=...

# 2. Start the stack with the tunnel profile
docker compose --profile tunnel up --build
```

This path requires a hostname on a domain in your Cloudflare account. If the
account has no zone, use the account-less `quick` profile below instead.

- The public hostname is configured in the dashboard's **Hostname routes** tab
  (Networks -> Routes; renamed from "Public Hostname" in older docs), not in
  this repo. Point it at `http://web:80` so one hostname serves both the SPA
  and the API. A token-managed tunnel has no `config.yml` inside the container,
  so the route really does have to be created dashboard-side.
- Because the hostname is stable, `CORS_ORIGINS` and `APP_BASE_URL` are set
  once rather than re-set on every restart.
- The tunnel is opt-in: a plain `docker compose up` stays local and never
  exposes the stack.

**Point the app at the public URL.** Set these in `.env` and restart so CORS,
invite links, and 2FA links use it:

```bash
CORS_ORIGINS=https://<your-hostname>
APP_BASE_URL=https://<your-hostname>
```

> Unlike the ngrok free tier there is no browser interstitial, so no
> skip-header workaround is needed for automated/API testing.

### Ephemeral tunnels, and running cloudflared on another device

No domain or Cloudflare account is required if you use a Quick Tunnel:

```bash
docker compose --profile quick up -d cloudflared-quick
docker compose logs cloudflared-quick        # prints the assigned URL
```

`TUNNEL_ORIGIN` (default `http://web:80`) selects what the tunnel serves. Set
it when `cloudflared` runs on a different device from this stack — the `web`
service publishes 8080 on every host interface and nginx still proxies `/api`
to `api`, so one URL serves the SPA and the API either way:

```bash
# From another device on the same network:
#   cloudflared tunnel --url http://<this-host-LAN-IP>:8080
# Confirm that address answers before starting cloudflared, so a firewall
# problem is not mistaken for a tunnel problem:
curl http://172.20.40.114:8080/
```

Two things to know before relying on this:

- **The URL changes on every restart**, so `CORS_ORIGINS` and `APP_BASE_URL`
  have to be re-set each time. That makes Quick Tunnels fine for a demo and a
  poor fit for anything needing a stable public endpoint.
- **The control plane is `api.trycloudflare.com`.** On a network that inspects
  TLS (Zscaler and similar) that host may present a certificate signed by a CA
  the container does not trust, and tunnel creation fails with `x509:
  certificate signed by unknown authority`. Notably, the *named* tunnel avoids
  this because its endpoints (`api.cloudflare.com`, `*.argotunnel.com`) are
  typically left alone by such proxies. If Quick Tunnels fail this way, either
  request a bypass for `api.trycloudflare.com` alone or add a domain and use
  the `tunnel` profile.

Quick Tunnels also carry no uptime guarantee and cap at 200 in-flight requests.

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
For internet testing, `CLOUDFLARE_TUNNEL_TOKEN`.
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

### Exercising `POST /payments` locally

The Amber Pay gateway has no real upstream yet, so its transport throws and
`POST /api/v1/payments` answers `502 ADAPTOR_CONNECTION_ERROR`. To exercise the
endpoint end to end, set in `.env` and recreate `api`:

```bash
AMBER_PAY_DEV_TRANSPORT=true
docker compose up -d api
```

`POST /payments` then returns `201` with a **fabricated** link, marked
`"simulated": true`. No request leaves the machine.

This needs two gates, not one: it is ignored entirely under `NODE_ENV=production`,
*and* it requires the explicit opt-in. Keying on `NODE_ENV` alone would be a
mistake here — the `tunnel` profile publishes this stack on a public Cloudflare
URL, and `NODE_ENV=development` is the normal setting for that profile, which would
leave a payment-minting endpoint on the open internet. The API logs a warning
whenever the dev transport is active.

The webhook route (`POST /api/v1/webhooks/amber-pay`) needs no such flag; it
reaches the whole pipeline today. Both routes are exercised by a Postman
collection kept alongside this project rather than in the repository, since it
carries environment-specific values (your sign-in, your webhook secret).

### Connecting QuickBooks

`QUICKBOOKS_CLIENT_ID` / `_SECRET` identify the app; they do **not** authorize a
call. QuickBooks needs a bearer token, so set one of:

- `QUICKBOOKS_ACCESS_TOKEN` — used as-is (Intuit issues these for ~1 hour), or
- `QUICKBOOKS_REFRESH_TOKEN` — exchanged at Intuit's token endpoint on connect,
  and re-exchanged automatically when an access token expires mid-run.

Also set `QUICKBOOKS_REALM_ID` (the company id) and, for a sandbox company,
`QUICKBOOKS_BASE_URL=https://sandbox-quickbooks.api.intuit.com`.

**The redirect URI must be registered against the app.** Intuit compares the
value we send to the app's Redirect URIs character for character, and reports a
mismatch as `invalid_redirect_uri` with no hint about which part differs. Unless
`QUICKBOOKS_REDIRECT_URI` is set, we send:

```
${APP_BASE_URL}/api/v1/settings/adaptor/callback
```

so with the default `APP_BASE_URL=http://localhost:8080` that is
`http://localhost:8080/api/v1/settings/adaptor/callback`. Add that exact string
under **Redirect URIs** for the app in the Intuit developer dashboard
(*Development → Keys & OAuth*), or set `QUICKBOOKS_REDIRECT_URI` to one that is
already registered. Intuit accepts `http` only for `localhost`; a public host
must be `https`, which also means a `trycloudflare.com` URL only works until it
changes on restart.

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
