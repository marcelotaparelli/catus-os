FROM node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
# Build only on Linux x64 with npm ci already completed. Bun is existing pinned tooling.
COPY node_modules/bun/bin/bun.exe /usr/local/bin/bun
COPY runner/src ./runner/src
COPY src/shared/delivery.ts ./src/shared/delivery.ts
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/bun","--no-env-file","/app/runner/src/gateway-server.ts"]
