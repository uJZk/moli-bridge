#!/bin/sh
# Run the pinned RSSHub retry tests with isolated configuration/logger mocks.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
upstream=${1:?Pass a checkout of RSSHub at the documented pinned commit}
expected=8f71938d4b9b032cab5712788d5ca8f4f327917c
actual=$(git -C "$upstream" rev-parse HEAD)
if [ "$actual" != "$expected" ]; then
  echo "Expected RSSHub commit $expected; got $actual" >&2
  exit 1
fi
stage=$(mktemp -d "${TMPDIR:-/tmp}/moli-rsshub-patch.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/lib/utils"
for file in playwright-fetch.ts playwright-fetch.test.ts; do
  git -C "$upstream" show "HEAD:lib/utils/$file" > "$stage/lib/utils/$file"
done
(cd "$stage" && git apply "$root/tools/rsshub/cdp-fetch-retry.patch")
npm install --prefix "$stage" --cache "${npm_config_cache:-${NPM_CONFIG_CACHE:-$stage/npm-cache}}" --no-save --no-audit --no-fund vitest@5.1.0
cat > "$stage/config.mjs" <<'CONFIG'
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: {
    '@/config': fileURLToPath(new URL('./stub-config.mjs', import.meta.url)),
    '@/utils/logger': fileURLToPath(new URL('./stub-logger.mjs', import.meta.url)),
    '@/utils/playwright': fileURLToPath(new URL('./stub-playwright.mjs', import.meta.url)),
  } },
  test: { watch: false, testTimeout: 10000 },
});
CONFIG
cat > "$stage/stub-config.mjs" <<'CONFIG'
export const config = { playwrightWSEndpoint: undefined, playwrightCDPEndpoint: undefined, requestTimeout: 30000 };
CONFIG
cat > "$stage/stub-logger.mjs" <<'LOGGER'
export default { warn() {} };
LOGGER
cat > "$stage/stub-playwright.mjs" <<'PLAYWRIGHT'
export function getPlaywrightPage() { throw new Error('test stub'); }
PLAYWRIGHT
(cd "$stage" && ./node_modules/.bin/vitest run --config config.mjs lib/utils/playwright-fetch.test.ts)
