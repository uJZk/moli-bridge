#!/bin/sh
set -eu
case "${MOLI_MODE:-both}" in
  both) exec node /app/container-supervisor.mjs ;;
  bridge) exec node /app/server.mjs ;;
  cdp) exec node /app/cdp-gateway.mjs ;;
  *) printf 'Unsupported MOLI_MODE: %s\n' "$MOLI_MODE" >&2; exit 2 ;;
esac
