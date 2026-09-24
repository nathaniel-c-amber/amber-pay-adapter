# ------------------------------------------------------------------
# Amber Pay Ledger — backend build (multi-stage)
# Stage 1: compile the TypeScript server with Node 20.
# Stage 2: minimal runtime with production deps + compiled dist.
#
# The `postbuild` step (scripts/copy-migrations.mjs) copies the SQL
# migrations into dist/db/migrations, so the runtime image carries them.
# ------------------------------------------------------------------

# --- Stage 1: build -------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies first (leverages Docker layer caching).
COPY server/package.json server/package-lock.json ./
RUN npm ci

# Copy the TS config, source and build scripts, then compile.
COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/scripts ./scripts
RUN npm run build

# --- Stage 2: runtime ----------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Copy the compiled output (including dist/db/migrations/*.sql).
COPY --from=build /app/dist ./dist

# Run as a non-root user for security.
RUN addgroup -S app && adduser -S app -G app
# The log sink writes to <LOG_DIR> (default `logs`, i.e. /app/logs) and runs as
# `app`, so the directory must exist and be owned by it. Without this the file
# sink would fall back to stdout-only with a permission error at startup.
RUN mkdir -p /app/logs && chown app:app /app/logs
USER app

EXPOSE 3300
CMD ["node", "dist/server.js"]