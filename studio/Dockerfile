# Ergon Studio — production image.
# Multi-stage: build the Vite app, then ship a lean runtime that serves the
# static bundle + the Node proxy/API from one process.

# ── build stage: compile the React app to static files ──
FROM node:20-slim AS build
WORKDIR /app
# install deps against the lockfile for reproducible builds
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build          # → dist/

# ── runtime stage: only what's needed to serve ──
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# production deps only. The accounts tier (better-sqlite3/bcryptjs) and the
# scale/secrets extras are optionalDependencies, so they install when present
# and the app degrades gracefully when they're not.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# app code + the built static bundle from the build stage
COPY server ./server
COPY --from=build /app/dist ./dist

# run as the non-root user the node image ships with
USER node

EXPOSE 8787

# container-native health check hits the liveness endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# apply pending DB migrations, then start the server. `npm start` runs the
# proxy in production mode (serves dist/ + the API). Migrations are forward-only
# and idempotent, so this is safe on every boot.
CMD ["sh", "-c", "node server/migrate_cli.mjs && npm start"]
