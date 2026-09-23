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
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]