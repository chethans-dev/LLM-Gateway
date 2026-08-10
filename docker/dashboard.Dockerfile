# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
ARG PNPM_VERSION=10.34.5
RUN npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — manifests only, so a source change does not re-run the install.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — Vite emits static files; nothing runs at request time.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @openllm/dashboard build

# ---------------------------------------------------------------------------
# runtime — nginx serves the SPA and proxies /v1 to the gateway.
#
# Proxying rather than letting the browser call the gateway directly means the
# dashboard is same-origin: no CORS configuration exists anywhere in the
# project, and the gateway does not need to know the dashboard's address.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
COPY docker/dashboard-nginx.conf /etc/nginx/templates/default.conf.template
# Templated so the gateway's address is configurable at run time rather than
# baked into the image.
ENV GATEWAY_URL=http://gateway:4000
EXPOSE 80
