# syntax=docker/dockerfile:1

# Node 24 is the active LTS and matches .nvmrc, so dev, CI, and production all
# run the same runtime. Pinning the major here is the difference between
# "works on my machine" and a reproducible build.
FROM node:24-alpine AS base
# Pinned to match the `packageManager` field in the root package.json.
ARG PNPM_VERSION=10.34.5
RUN npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — manifests only, so a source-only change does not re-run the install.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile the workspace. `pnpm -r build` walks packages in dependency
# order, so @openllm/core is built before the gateway that references it.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/gateway apps/gateway
RUN pnpm -r build

# ---------------------------------------------------------------------------
# dev — source is bind-mounted by docker-compose; tsx watches and reloads.
# ---------------------------------------------------------------------------
FROM build AS dev
ENV NODE_ENV=development
EXPOSE 4000
CMD ["pnpm", "--filter", "@openllm/gateway", "dev"]

# ---------------------------------------------------------------------------
# runtime — production dependencies only, non-root.
# ---------------------------------------------------------------------------
FROM build AS runtime
ENV NODE_ENV=production

# Drops devDependencies (typescript, tsx, vitest, drizzle-kit) from the image.
# Smaller surface to ship and smaller surface to attack.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm store prune || true

# Running as root inside a container means a container escape starts as root.
RUN addgroup -S gateway && adduser -S gateway -G gateway \
  && chown -R gateway:gateway /app
USER gateway

EXPOSE 4000
CMD ["node", "apps/gateway/dist/index.js"]
