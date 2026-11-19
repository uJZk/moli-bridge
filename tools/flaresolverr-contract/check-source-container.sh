#!/bin/sh
# Test the mounted source Moli in two separate network-isolated containers.
set -eu
if [ "$#" -ne 2 ]; then
  printf 'Usage: %s /absolute/path/to/moli bridge-image\n' "$0" >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
binary=$(realpath "$1")
image=$2
test -x "$binary" || { echo 'Moli executable not found.' >&2; exit 1; }
for role in bridge cdp; do
  docker run --rm --pull=never --network none --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m --cap-drop ALL \
    --security-opt no-new-privileges:true --entrypoint node -e "MOLI_MODE=$role" \
    --mount "type=bind,src=$binary,dst=/opt/moli/moli,readonly" \
    --mount "type=bind,src=$root/tools/flaresolverr-contract/check-source-container.mjs,dst=/source-check.mjs,readonly" \
    "$image" /source-check.mjs
done
