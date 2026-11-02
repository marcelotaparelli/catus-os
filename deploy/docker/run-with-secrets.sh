#!/bin/sh
# Loads <NAME>_FILE secrets (Compose secrets under /run/secrets) into <NAME>
# for the wrapped process only, then execs it. Values are never printed.
# Only the names below are accepted; anything else is ignored.
set -eu
for name in RUNTIME_DATABASE_URL MAINTENANCE_DATABASE_URL OIDC_CLIENT_SECRET; do
  eval "file=\${${name}_FILE:-}"
  [ -n "$file" ] || continue
  if [ ! -r "$file" ]; then
    echo "secret file for $name is not readable" >&2
    exit 1
  fi
  value=$(cat "$file")
  export "$name=$value"
  unset "${name}_FILE"
done
unset value file
exec "$@"
