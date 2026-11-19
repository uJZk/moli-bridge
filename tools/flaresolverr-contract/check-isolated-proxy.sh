#!/bin/sh
# Run local FlareSolverr contract fixtures on an internal Docker network.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
plugin=${MOVIEPILOT_SOURCE:-/tmp/moli-moviepilot-captcha.py}
bridge_image=${MOLI_BRIDGE_IMAGE:-moli-bridge:local}
runner_image=${PYTHON_TEST_IMAGE:-rust:1.96.1-bookworm}
if [ ! -f "$plugin" ]; then
  printf 'MoviePilot source not found: %s\n' "$plugin" >&2
  exit 1
fi
plugin=$(CDPATH= cd -- "$(dirname -- "$plugin")" && pwd)/$(basename -- "$plugin")
printf '%s  %s\n' 6fc4af7553939e03347cf52b1f290cbe2fb1e8aeec7889b3ec6c987410c5e758 "$plugin" | sha256sum -c -
docker image inspect "$bridge_image" >/dev/null
docker image inspect "$runner_image" >/dev/null
token=$(node -e "console.log(require('node:crypto').randomBytes(8).toString('hex'))")
network_name="moli-proxy-$token"
bridge_name="moli-proxy-bridge-$token"
runner_name="moli-proxy-runner-$token"
cleanup() {
  docker rm -f "$runner_name" >/dev/null 2>&1 || true
  docker rm -f "$bridge_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
docker network create --internal "$network_name" >/dev/null
docker run -d --rm --pull=never --name "$bridge_name" --network "$network_name" --network-alias bridge \
  -e "BRIDGE_MAX_SESSIONS=${BRIDGE_TEST_MAX_SESSIONS:-8}" "$bridge_image" >/dev/null
ready=0
for _ in $(seq 1 30); do
  if docker exec "$bridge_name" node /app/healthcheck.mjs >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then docker logs "$bridge_name"; exit 1; fi
docker run --rm --pull=never --name "$runner_name" --network "$network_name" --network-alias runner \
  --mount "type=bind,src=$root/tools/flaresolverr-contract/check.py,dst=/test/check.py,readonly" \
  --mount "type=bind,src=$plugin,dst=/test/plugin.py,readonly" \
  "$runner_image" python3 /test/check.py --endpoint http://bridge:8191/v1 \
  --moviepilot-source /test/plugin.py --listen 0.0.0.0 --fixture-host runner --test-proxy "$@"
