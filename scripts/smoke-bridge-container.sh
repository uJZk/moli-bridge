#!/bin/sh
# Exercise both roles of a locally loaded image and clean up test containers.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$root/flaresolverr-bridge/compose.yaml"
project=${MOLI_SMOKE_PROJECT:-moli-bridge-smoke}
export MOLI_BRIDGE_IMAGE=${MOLI_BRIDGE_IMAGE:-moli-bridge:local}
cleanup() { docker compose -p "$project" -f "$compose_file" down --remove-orphans; }
trap cleanup EXIT HUP INT TERM
docker compose -p "$project" -f "$compose_file" up -d --no-build
verify_role() {
  role=$1
  id=$(docker compose -p "$project" -f "$compose_file" ps -q "$role")
  test -n "$id"
  ready=0
  for attempt in $(seq 1 30); do
    if docker exec "$id" node /app/healthcheck.mjs >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then
    docker compose -p "$project" -f "$compose_file" logs --no-color "$role"
    exit 1
  fi
  docker exec -i "$id" node --input-type=module < "$root/tools/flaresolverr-contract/check-container.mjs"
}
for role in bridge cdp; do
  verify_role "$role"
done
for role in cdp bridge; do
  docker compose -p "$project" -f "$compose_file" restart "$role"
  verify_role "$role"
done
