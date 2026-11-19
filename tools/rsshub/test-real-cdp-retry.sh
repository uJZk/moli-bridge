#!/bin/sh
# Exercise pinned RSSHub source and Patchright against a local Moli CDP gateway.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
upstream=${1:?Pass a checkout of RSSHub at the documented pinned commit}
shift
expected=8f71938d4b9b032cab5712788d5ca8f4f327917c
actual=$(git -C "$upstream" rev-parse HEAD)
if [ "$actual" != "$expected" ]; then
  echo "Expected RSSHub commit $expected; got $actual" >&2
  exit 1
fi
test -n "${MOLI_TEST_BINARY:-}" || { echo 'Set MOLI_TEST_BINARY to an absolute Moli executable path' >&2; exit 1; }
stage=$(mktemp -d "${TMPDIR:-/tmp}/moli-rsshub-real-test.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/lib/utils" "$stage/lib/routes/ups"
for file in playwright.ts playwright-utils.ts playwright-fetch.ts playwright-fetch.test.ts parse-date.ts; do
  git -C "$upstream" show "HEAD:lib/utils/$file" > "$stage/lib/utils/$file"
done
git -C "$upstream" show HEAD:lib/routes/ups/track.ts > "$stage/lib/routes/ups/track.ts"
(cd "$stage" && git apply "$root/tools/rsshub/cdp-fetch-retry.patch")
if [ "${MOLI_TEST_AUTH_PROXY_PATCH:-0}" = 1 ]; then
  (cd "$stage" && git apply "$root/tools/rsshub/moli-cdp-auth-proxy.patch")
fi
if [ "${MOLI_TEST_UNPATCHED_UPS:-0}" != 1 ]; then
  (cd "$stage" && git apply "$root/tools/rsshub/moli-ups-dynamic-table.patch")
fi
cp "$root/tools/rsshub/real-cdp-retry.test.ts" "$stage/real-cdp-retry.test.ts"
cp "$root/tools/rsshub/socks5-proxy-fixture.mjs" "$stage/socks5-proxy-fixture.mjs"
if [ -n "${MOLI_RSSHUB_NODE_MODULES:-}" ]; then
  ln -s "$MOLI_RSSHUB_NODE_MODULES" "$stage/node_modules"
else
  npm install --prefix "$stage" --cache "${npm_config_cache:-${NPM_CONFIG_CACHE:-$stage/npm-cache}}" --no-save --no-audit --no-fund --ignore-scripts vitest@5.1.0 patchright@1.64.3 cheerio@1.2.0 dayjs@1.11.23
fi
export RSSHUB_PATCHRIGHT_PATH=${RSSHUB_PATCHRIGHT_PATH:-$stage/node_modules/patchright/index.mjs}
export MOLI_PROJECT_ROOT=$root
node -e '
  const fs = require("node:fs"), path = require("node:path");
  const vitest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
  const patchright = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[2]), "package.json"), "utf8")).version;
  const cheerio = JSON.parse(fs.readFileSync(path.join(process.argv[3], "cheerio/package.json"), "utf8")).version;
  const dayjs = JSON.parse(fs.readFileSync(path.join(process.argv[3], "dayjs/package.json"), "utf8")).version;
  if (vitest !== "5.1.0" || patchright !== "1.64.3" || cheerio !== "1.2.0" || dayjs !== "1.11.23") throw new Error(`Unexpected dependency versions: ${vitest}, ${patchright}, ${cheerio}, ${dayjs}`);
' "$stage/node_modules/vitest/package.json" "$RSSHUB_PATCHRIGHT_PATH" "$stage/node_modules"
cat > "$stage/config.mjs" <<'CONFIG'
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: [
    { find: 'patchright', replacement: process.env.RSSHUB_PATCHRIGHT_PATH },
    { find: '@/config', replacement: fileURLToPath(new URL('./stub-config.mjs', import.meta.url)) },
    { find: '@/utils/logger', replacement: fileURLToPath(new URL('./lib/utils/logger.mjs', import.meta.url)) },
    { find: '@/utils/playwright', replacement: fileURLToPath(new URL('./lib/utils/playwright.ts', import.meta.url)) },
    { find: '@/utils/parse-date', replacement: fileURLToPath(new URL('./lib/utils/parse-date.ts', import.meta.url)) },
  ] },
  test: { watch: false, testTimeout: 30000, hookTimeout: 30000 },
});
CONFIG
cat > "$stage/stub-config.mjs" <<'CONFIG'
export const config = {
  get playwrightCDPEndpoint() { return process.env.MOLI_FIXTURE_CDP; },
  playwrightWSEndpoint: undefined, requestTimeout: 20000,
  ua: 'RSSHub-real-CDP-fixture', chromiumExecutablePath: undefined,
};
CONFIG
cat > "$stage/lib/utils/logger.mjs" <<'LOGGER'
export default { warn(...args) { console.warn(...args); }, debug() {} };
LOGGER
cat > "$stage/lib/utils/proxy.mjs" <<'PROXY'
export default {
  proxyIsPAC: false, proxyObj: { url_regex: '.*' },
  get proxyUri() { return process.env.MOLI_FIXTURE_PROXY; },
  get proxyUrlHandler() { return new URL(process.env.MOLI_FIXTURE_PROXY); },
};
PROXY
(cd "$stage" && ./node_modules/.bin/vitest run --config config.mjs real-cdp-retry.test.ts "$@")
