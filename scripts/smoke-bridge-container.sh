#!/bin/sh
# Exercise both endpoints in one disposable container.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$root/flaresolverr-bridge/compose.yaml"
project=${MOLI_SMOKE_PROJECT:-moli-bridge-smoke-$$}
export MOLI_BRIDGE_IMAGE=${MOLI_BRIDGE_IMAGE:-moli-bridge:local}
export BRIDGE_DIAGNOSTICS=${BRIDGE_DIAGNOSTICS:-1}
cleanup() { docker compose -p "$project" -f "$compose_file" down --remove-orphans; }
trap cleanup EXIT HUP INT TERM
docker compose -p "$project" -f "$compose_file" up -d --no-build
verify_role() {
  role=$1
  id=$(docker compose -p "$project" -f "$compose_file" ps -q moli)
  test -n "$id"
  ready=0
  for attempt in $(seq 1 30); do
    if docker exec "$id" node /app/healthcheck.mjs >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then
    docker compose -p "$project" -f "$compose_file" logs --no-color moli
    exit 1
  fi
  docker exec -i -e "MOLI_TEST_ROLE=$role" "$id" node --input-type=module < "$root/tools/flaresolverr-contract/check-container.mjs"
  if [ "$role" = bridge ] && [ "$BRIDGE_DIAGNOSTICS" = 1 ]; then
    logs=$(docker logs "$id" 2>&1 | grep 'bridge-diagnostic' || true)
    printf '%s\n' "$logs" | grep -F '"event":"window-error","name":"TypeError"' >/dev/null
    printf '%s\n' "$logs" | grep -F '"event":"window-error","name":"ReferenceError"' >/dev/null
    printf '%s\n' "$logs" | grep -F '"event":"navigation-cookie"' | grep -F '"clearance":"nonempty"' >/dev/null
    printf '%s\n' "$logs" | grep -F '"event":"recovery-attempt","provider":"cloudflare"' >/dev/null
    if printf '%s\n' "$logs" | grep -E 'private_diagnostic_marker|container-fresh' >/dev/null; then
      echo 'Diagnostic logs exposed fixture content or a cookie value' >&2
      exit 1
    fi
    echo 'PASS bridge diagnostics: synchronous and asynchronous script errors and redaction'
  fi
}
for role in bridge cdp; do
  verify_role "$role"
done
docker compose -p "$project" -f "$compose_file" restart moli
for role in bridge cdp; do
  verify_role "$role"
done
