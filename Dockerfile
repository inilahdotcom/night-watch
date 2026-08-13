# syntax=docker/dockerfile:1.7

# Single-image Docker build for Night Watch. One image, three service roles:
#   `migrate` runs the initial + subsequent SQL migrations against the shared DB,
#   `web`     serves the TanStack Start dashboard,
#   `worker`  runs the scheduled collectors + analysis + alerting.
#
# Two processes share one SQLite file via a mounted volume — WAL mode on the
# same filesystem is well-behaved with a single writer + many readers. See
# `docker-compose.yml` for how the volumes are wired.

FROM oven/bun:1.3.14 AS deps

WORKDIR /app

# Copy the workspace manifests first so `bun install` gets cached when
# only source changes.
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM deps AS build

# Bring in the actual source.
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/worker apps/worker
COPY apps/web apps/web
COPY config config

# Build the dashboard bundle. Worker is TS-native under Bun and needs no build.
RUN cd apps/web && bun run build

# ---------------------------------------------------------------------------
FROM oven/bun:1.3.14 AS runtime

WORKDIR /app

# Copy over the fully installed + built workspace.
COPY --from=build /app /app

# Data + WhatsApp auth live under /data (mounted volume in compose). Config
# is bind-mounted read-only at /config so operators can edit monitors.json
# without rebuilding.
ENV NODE_ENV=production \
    DATABASE_URL=/data/night-watch.db \
    MONITORS_CONFIG_PATH=/config/monitors.json \
    WA_AUTH_DIR=/data/auth_wa \
    LOG_LEVEL=info

RUN mkdir -p /data && chown -R bun:bun /data /app

USER bun

# No default CMD — each compose service supplies its own.
CMD ["bun", "--help"]
