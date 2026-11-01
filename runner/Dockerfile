FROM node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /runner
# Responses client has no SDK/CLI or additional runtime dependency.
COPY runner/src ./src
COPY src/shared/delivery.ts /src/shared/delivery.ts
USER 1000:1000
ENTRYPOINT ["node","--experimental-strip-types","/runner/src/responses-entry.ts"]
