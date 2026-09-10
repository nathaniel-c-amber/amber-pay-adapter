# Amber Pay — Connector Monitor

Operational monitoring for the Amber Pay gateway and its accounting adaptors
(QuickBooks, Sage). Backend API + monitoring dashboard. **No financial or
customer data** — operational statuses and reference hashes only.

## Stack

- **Backend** (`server/`) — Express + TypeScript (ESM, NodeNext), PostgreSQL 16,
  PBAC auth, webhook pipeline. Node 20.
- **Frontend** (`src/`) — React 19 + Vite + TypeScript + TanStack Table.
- **Deployment** — Docker Compose (PostgreSQL 16, backend Node 20, frontend nginx).

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

| Service | Port (host) | Notes |
| ------- | ----------- | ----- |
| `web`   | `8080`      | Frontend SPA (nginx) |
| `api`   | `3000`      | Backend API (`/health`, `/api/v1/*`) |
| `db`    | `5432`      | PostgreSQL 16 (internal to the stack) |

The `api` service runs migrations on startup and waits for `db` to be healthy.
PostgreSQL data persists in the `db-data` volume.

## Environment / secrets

docker-compose reads a root `.env` file automatically. Required vars:

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `JWT_SECRET` (>= 16 chars)
- `CORS_ORIGINS` (the frontend origin, e.g. `http://localhost:8080`)
- `AMBER_PAY_WEBHOOK_SECRET`

Optional: `AMBER_PAY_*`, `QUICKBOOKS_*`, `SAGE_*`, `SENDGRID_API_KEY`.
See `.env.example` for the full list. **Never commit real secrets.**

## Development (without Docker)

Backend:

```bash
cd server
cp .env.example .env   # set DATABASE_URL, JWT_SECRET, etc.
npm install
npm run dev            # tsx watch, port 3000
```

Frontend:

```bash
npm install
npm run dev            # Vite dev server, port 5173
```

## Notes

- The frontend is **not yet wired to the backend API** (Phase 7). It currently
  serves its static build; the API is reachable independently at `:3000`.
- Backend tests run without a live DB (in-memory repositories); Postgres
  integration tests are skipped unless a real `DATABASE_URL` is configured.