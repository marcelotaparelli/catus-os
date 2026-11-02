#!/bin/sh
# Compatibility shim installed as `docker` ONLY inside the tools image.
# scripts/lib/backup.ts runs pg_dump/pg_restore as
#   docker ... run ... --entrypoint <tool> <pinned postgres image> <tool args>
# The tools image IS that pinned image, so the same binaries run directly, with
# no Docker socket. Anything other than that exact pinned image is refused.
set -eu
pinned='postgres@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db'
tool=''
while [ $# -gt 0 ]; do
  case "$1" in
    --entrypoint)
      tool="$2"
      shift 2
      ;;
    "$pinned")
      shift
      case "$tool" in
        pg_dump | pg_restore) exec "$tool" "$@" ;;
        *) echo "pg-client-shim: tool not allowed" >&2; exit 2 ;;
      esac
      ;;
    *) shift ;;
  esac
done
echo "pg-client-shim: only the pinned PostgreSQL client image is supported" >&2
exit 2
