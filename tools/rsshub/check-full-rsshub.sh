#!/bin/sh
# Run full RSSHub against local TLS and proxy fixtures in a network-isolated container.
set -eu
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  printf 'Usage: %s /path/to/built/RSSHub /path/to/node24 [bridge-image]\n' "$0" >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
rsshub=$(CDPATH= cd -- "$1" && pwd)
node=$(realpath "$2")
image=${3:-moli-bridge:local}
test -f "$rsshub/dist/index.mjs" || { echo 'RSSHub dist/index.mjs not found; build the patched source first.' >&2; exit 1; }
test -d "$rsshub/node_modules" || { echo 'RSSHub node_modules not found.' >&2; exit 1; }
"$node" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (!((major===24 && minor>=15)||(major===26 && minor>=13))) process.exit(1)' || {
  echo 'RSSHub requires Node.js ^24.15.0 or ^26.13.0.' >&2; exit 1;
}
stage=$(mktemp -d "${TMPDIR:-/tmp}/moli-rsshub-full.XXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 -subj '/CN=www.ups.com' \
  -addext 'subjectAltName=DNS:www.ups.com,DNS:api.bilibili.com,IP:127.0.0.1' -keyout "$stage/key.pem" -out "$stage/cert.pem" >/dev/null 2>&1
if [ "${MOLI_TEST_UNTRUSTED_PROXY:-0}" = 1 ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 -subj '/CN=untrusted-proxy' \
    -addext 'subjectAltName=IP:127.0.0.1' -keyout "$stage/untrusted-key.pem" -out "$stage/untrusted-cert.pem" >/dev/null 2>&1
fi
docker run --rm --pull=never --network none --user 0 --entrypoint /node24 \
  --mount "type=bind,src=$rsshub,dst=/rsshub,readonly" \
  --mount "type=bind,src=$node,dst=/node24,readonly" \
  --mount "type=bind,src=$root/tools/rsshub/check-full-rsshub.mjs,dst=/harness.mjs,readonly" \
  --mount "type=bind,src=$root/tools/rsshub/socks5-proxy-fixture.mjs,dst=/socks5-proxy-fixture.mjs,readonly" \
  --mount "type=bind,src=$stage,dst=/fixture,readonly" \
  -e "MOLI_TEST_PROXY_KIND=${MOLI_TEST_PROXY_KIND:-http}" \
  -e "MOLI_TEST_SOCKS5H_ALIAS=${MOLI_TEST_SOCKS5H_ALIAS:-0}" \
  -e "MOLI_TEST_UNTRUSTED_PROXY=${MOLI_TEST_UNTRUSTED_PROXY:-0}" \
  -e "MOLI_TEST_DIRECT_CDP=${MOLI_TEST_DIRECT_CDP:-0}" \
  -e "MOLI_TEST_BILIBILI_RETRY=${MOLI_TEST_BILIBILI_RETRY:-0}" \
  -e "MOLI_TEST_EXPECT_NODE_RETRY=${MOLI_TEST_EXPECT_NODE_RETRY:-1}" \
  --workdir /rsshub "$image" /harness.mjs
