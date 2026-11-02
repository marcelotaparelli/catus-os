# PostgreSQL 18.3 (same pinned digest as the backup clients) running as the
# host operator UID/GID, so the protected secret files stay 0600 on the host.
FROM postgres@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db
ARG CATUS_UID=1000
ARG CATUS_GID=1000
RUN groupmod -o -g "$CATUS_GID" postgres \
 && usermod -o -u "$CATUS_UID" -g "$CATUS_GID" postgres \
 && chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql
USER postgres
