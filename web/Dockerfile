# ------------------------------------------------------------------
# Amber Pay Ledger — frontend build (multi-stage)
# Stage 1: build the Vite/React app with Node 20.
# Stage 2: serve the static build with nginx (SPA routing).
# ------------------------------------------------------------------

# --- Stage 1: build -------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies first (leverages Docker layer caching).
COPY package.json package-lock.json ./
RUN npm ci

# Copy the app source and build config, then build.
COPY index.html ./
COPY tsconfig.json tsconfig.app.json ./
COPY vite.config.ts ./
COPY src ./src
RUN npm run build

# --- Stage 2: serve ------------------------------------------------
FROM nginx:alpine AS serve
# The security headers live in their own file because nginx needs them included
# in every `location` that sets its own `add_header` (they do not merge across
# levels). It must sit outside conf.d, which is included at http level.
#
# It is a TEMPLATE, not a static file. The CSP's `form-action` has to name the
# payment gateway so the browser is allowed to post a card form to it, and that
# host is deployment configuration — hardcoding it would be wrong on every
# deployment but one while still looking correct. The official nginx image runs
# envsubst over /etc/nginx/templates/*.template on startup, writing to
# NGINX_ENVSUBST_OUTPUT_DIR, which is pointed at the snippets directory the
# includes in nginx.conf already reference.
COPY templates/security-headers.conf.template /etc/nginx/templates/security-headers.conf.template
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# Where the rendered snippet is written. Without this it would land in conf.d,
# where it would be included at http level and silently lose to the
# location-level `add_header` that discards inherited ones.
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/snippets
# The directory has to EXIST before envsubst runs, and nothing else creates it
# any more: the old static file used to arrive by COPY, which made the directory
# implicitly. Rendering failed with "is not writable" and nginx then refused to
# start on the missing include — a container that came up, logged an error, and
# served nothing.
RUN mkdir -p /etc/nginx/snippets
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]