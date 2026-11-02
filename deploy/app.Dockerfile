# Catus OS images (one Dockerfile, two targets):
#   app   — HTTP runtime, TCP edge forwarder and retention worker (Node base)
#   tools — administrative one-shot tasks (pinned PostgreSQL 18.3 client base)
# Same pinned Node base already used by CI (runner/Dockerfile).
FROM node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts svelte.config.js tsconfig.json ./
COPY src ./src
RUN npm run build
# Runtime needs only production dependencies plus the pinned Bun binary.
RUN cp node_modules/bun/bin/bun.exe /tmp/bun \
 && npm prune --omit=dev --no-audit --no-fund \
 && install -D -m 755 /tmp/bun node_modules/.bin/bun

FROM node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS app
ENV NODE_ENV=production HOME=/tmp BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY deploy/docker ./deploy/docker
# Code is root-owned and read-only for the unprivileged service user chosen at runtime.
RUN chmod -R a+rX,go-w /app && chmod 755 /app/deploy/docker/*.sh
USER 1000:1000
ENTRYPOINT ["/app/deploy/docker/run-with-secrets.sh"]
CMD ["node", "scripts/runtime.mjs"]

# Same PostgreSQL client image pinned by scripts/lib/backup.ts, so pg_dump/pg_restore
# 18.3 and openssl are exactly the binaries the code expects.
FROM postgres@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db AS tools
ENV HOME=/tmp BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /app
COPY --from=app /app /app
RUN install -m 755 /app/node_modules/.bin/bun /usr/local/bin/bun \
 && install -m 755 /app/deploy/docker/pg-client-shim.sh /usr/local/bin/docker
USER 1000:1000
ENTRYPOINT ["/app/deploy/docker/tools.sh"]
