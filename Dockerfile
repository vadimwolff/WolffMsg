# syntax=docker/dockerfile:1
#
# WolffMsg — two images from one build.
#
#   --target web      nginx serving the built client and proxying to the server
#   --target server   the API, WebSocket hub, blob store — and the client too
#
# `server` is deliberately the last stage, so a plain `docker build .` produces
# the all-in-one image: one container serving both the app and its API. That is
# what a single-service host gives you, and it is *same-origin*, which keeps the
# session cookie at `SameSite=strict` — the strongest CSRF defence available.
# The easiest deployment is therefore also the safest one.
#
# The compose stack still uses both stages, because nginx serves static files
# better than Node does. Either way the browser sees a single origin. See
# SECURITY.md for what a split-origin deployment costs instead.

# ── Shared build stage ──────────────────────────────────────────────────────
# One `npm ci` for the whole workspace: the client and the server share the
# crypto package, and building them from the same tree is what guarantees they
# agree on the wire format.
FROM node:22-alpine AS build
WORKDIR /app

# openssl is a Prisma engine dependency, not an optional extra.
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY scripts/ scripts/

RUN npm ci --no-audit --no-fund

COPY packages/ packages/

RUN npm run build -w @wolffmsg/shared
RUN npx prisma generate --schema packages/server/prisma/schema.prisma
RUN npm run build -w @wolffmsg/server

# The client is built here too so both images come from one dependency tree.
# BASE_PATH stays "/" and VITE_API_ORIGIN stays empty: nginx puts the API on
# this same origin, so every request is a relative path.
RUN npm run build -w @wolffmsg/web


# ── Web runtime ─────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS web

COPY --from=build /app/packages/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080


# ── Server runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS server
WORKDIR /app

RUN apk add --no-cache openssl tini

ENV NODE_ENV=production

# All three manifests, not just the two this image runs: `npm ci` validates the
# lockfile against every workspace the root declares, and refuses to run if one
# is missing.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# `--omit=dev` after the build, so nothing that only compiles code ships.
# `--ignore-scripts` skips the postinstall patch, which only matters to the
# browser bundle.
#
# The `prisma` CLI is a runtime dependency of the server package rather than a
# dev one, precisely so it survives this: the entrypoint runs `migrate deploy`
# on boot, and having the CLI and the client installed together is what keeps
# them at the same version.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/prisma packages/server/prisma

# The built client, so this image can serve the whole app on its own. The
# compose stack puts nginx in front and ignores it; a single-service host —
# which is what most free tiers give you — serves it from here, and is
# same-origin as a result. See packages/server/src/web.ts.
COPY --from=build /app/packages/web/dist packages/web/dist
# The generated Prisma client and its query engine.
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client node_modules/@prisma/client

COPY docker/server-entrypoint.sh /usr/local/bin/server-entrypoint.sh
RUN chmod +x /usr/local/bin/server-entrypoint.sh

# Encrypted blobs live here. The volume is declared so an image rebuild never
# takes someone's attachments with it.
RUN mkdir -p /app/storage && chown -R node:node /app/storage
VOLUME ["/app/storage"]

# Never root: a path-traversal or upload bug should not reach the filesystem
# with more authority than the app needs.
USER node

ENV HOST=0.0.0.0 \
    PORT=4000 \
    STORAGE_PATH=/app/storage \
    WEB_ROOT=/app/packages/web/dist
EXPOSE 4000

# tini reaps zombies and forwards SIGTERM, so `docker stop` reaches the
# server's own graceful shutdown instead of being a kill.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/server-entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]

