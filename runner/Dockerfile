FROM node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /runner
COPY runner/package.json runner/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca,required=true NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --ignore-scripts --strict-ssl=true
COPY runner/src/sdk-entry.ts ./src/sdk-entry.ts
USER 1000:1000
ENTRYPOINT ["node","--experimental-strip-types","/runner/src/sdk-entry.ts"]
