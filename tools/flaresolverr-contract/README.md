# FlareSolverr compatibility checks

This is an executable acceptance test for a bridge under development. It uses Python 3's standard library and a local HTTP fixture. It exercises session creation/list/deletion, isolated and retained cookies, POST data, HTTP status, navigation after a challenge and while the initial page is still loading, ordinary pages with short delayed redirects, meta-refresh GET and POST navigation, chained redirects, reloads and redirect loops, response-header-only and DDoS-Guard marker challenges, verification-button and challenge iframe/open-shadow interaction, unrelated-iframe safety, Cloudflare and DDoS-Guard clearance-cookie recovery without POST replay, fixture Turnstile token extraction, final-document headers and cookies, `returnOnlyCookies`, an invalid command, active versus queued request deadlines, busy-session TTL rotation, and original-URL POST replay checks. It also extracts and executes the real `fs_create_session`, `fs_get`, `fs_call` and cleanup helpers from the MoviePilot plugin to verify its cookie and header handoff. The plugin source is read locally and is not vendored.

The reference plugin revision is `7c7d1036423f3e7350f307c7ad87bd6d2044712a`. Obtain and check it, then run against a bridge that is already running:

```sh
curl -fsSL https://raw.githubusercontent.com/Vivitoto/MoviePilot-Plugins/7c7d1036423f3e7350f307c7ad87bd6d2044712a/plugins.v3/sehuatangsignin/captcha_server.py -o /tmp/moli-moviepilot-captcha.py
printf '%s  %s\n' 6fc4af7553939e03347cf52b1f290cbe2fb1e8aeec7889b3ec6c987410c5e758 /tmp/moli-moviepilot-captcha.py | sha256sum -c
python3 tools/flaresolverr-contract/check.py --endpoint http://127.0.0.1:8191/v1 --moviepilot-source /tmp/moli-moviepilot-captcha.py
```

The browser backend must be able to connect to the fixture. For a bridge in another container or host, use `--listen 0.0.0.0 --fixture-host <reachable-host> --fixture-port <port>` and configure the network accordingly. Do not expose this test fixture on an untrusted network. The endpoint must be a disposable test instance: tests create and destroy sessions.

Add `--test-proxy` to start a fixture-only HTTP proxy and exercise the plugin's proxy configuration. The proxy checks cover unauthenticated access, query parameters, HTTP Basic authentication supplied in the URL or separate fields, preservation across TTL rotation, and rejection without direct fallback for incorrect credentials. Use a non-loopback `--fixture-host` reachable by the bridge: browsers commonly bypass proxies for loopback destinations. The proxy binds another ephemeral port, which must also be reachable from the bridge. These checks are skipped unless explicitly enabled; a run with those skips does not establish proxy compatibility.

For a focused run, add `--test test_moviepilot_proxy` (or another `Contract`
test name); repeat `--test` to select multiple cases. Use the default full
suite for broad regression coverage.

With Docker, the pinned plugin source, a locally built bridge image and a local
Python image, the following runs the suite on a temporary internal network with
the fixture-only proxy; it does not contact external target sites:

```sh
MOLI_BRIDGE_IMAGE=moli-bridge:local ./tools/flaresolverr-contract/check-isolated-proxy.sh
BRIDGE_TEST_MAX_SESSIONS=1 MOLI_BRIDGE_IMAGE=moli-bridge:local ./tools/flaresolverr-contract/check-isolated-proxy.sh --test test_moviepilot_proxy
```

`MOVIEPILOT_SOURCE` overrides the default `/tmp/moli-moviepilot-captcha.py`;
the script verifies its pinned SHA-256. `PYTHON_TEST_IMAGE` overrides the default
local `rust:1.96.1-bookworm` image. Both images must already exist locally.
Build the bridge image from the source under test before running it; the script
does not rebuild or deploy anything. The network and containers are removed on exit.

To test the FlareSolverr API with authenticated SOCKS5 and HTTPS proxies,
OpenSSL and a local Moli executable, run:

```sh
MOLI_TEST_BINARY=/absolute/path/to/moli node tools/flaresolverr-contract/check-authenticated-proxy.mjs
MOLI_TEST_PROXY_KIND=https MOLI_TEST_BINARY=/absolute/path/to/moli node tools/flaresolverr-contract/check-authenticated-proxy.mjs
MOLI_TEST_PROXY_KIND=https MOLI_TEST_UNTRUSTED_PROXY=1 MOLI_TEST_BINARY=/absolute/path/to/moli node tools/flaresolverr-contract/check-authenticated-proxy.mjs
```

This starts a disposable bridge, a loopback proxy and a local TLS fixture. The
proxy accepts only the fixture domain, and a Moli wrapper rejects
missing or unexpected proxy settings. The check covers proxy-side domain
resolution, the SOCKS5H alias, credentials in the URL and separate fields, reserved characters,
session expiry and rejection of wrong credentials. The HTTPS test also checks
that an untrusted proxy certificate fails before CONNECT. The wrapper supplies
the test CA; it does not change the system trust store. These checks do not run
MoviePilot or contact a real target site.

Passing the MoviePilot checks is necessary but not sufficient for MoviePilot compatibility. Those fixtures cover session expiry, screenshot output and HTTP proxy authentication, but not other proxy protocols, protected websites, plugin Playwright/browser/direct POST paths, or isolation from the external CDP service. A success against a mock is a test of the harness only. The plugin uses additional browser and direct HTTP paths outside the FlareSolverr API; see [the investigation](../../docs/flaresolverr-bridge-investigation.md).

## Cross-origin challenge frame fixture

With OpenSSL and the pinned Moli executable available, run:

```sh
MOLI_TEST_BINARY=/absolute/path/to/moli node tools/flaresolverr-contract/check-cross-origin-frame.mjs
```

The check generates a temporary certificate and starts a loopback HTTPS server named `challenges.cloudflare.com`. A test-only Moli wrapper maps that hostname to loopback and trusts the temporary certificate for that process. It exercises a cross-origin frame, open and closed shadow-root native and ARIA checkboxes, page clearance, token handoff, and safety for checked or disabled controls, overlays and interactive descendants; it does not contact Cloudflare or establish real Turnstile success. The temporary certificate, servers, and processes are removed when the check exits.

## Jackett clearance handoff

With a disposable local bridge already running and .NET SDK 8 installed:

```sh
python3 tools/flaresolverr-contract/check-jackett-sharp.py --bridge http://127.0.0.1:8191/ --dotnet dotnet
```

The fixture runs on loopback and must be reachable by the bridge. The test restores the exact FlareSolverrSharp 4.0.0 NuGet package used by pinned Jackett commit `ffe6cd64391787612967a2cd28850970720d9fe3`. It exercises the real handler's original challenge request, FlareSolverr call, clearance cookie and user-agent handoff, and subsequent direct retry. It also checks the handler's errors when cookies are absent or unrelated to Cloudflare/DDoS-Guard. A DataDome-only response is not sent to the bridge, and a `datadome` cookie returned after a separately recognized challenge is not injected into the retry. These local checks do not establish actual indexer or live challenge success.

An [optional FlareSolverrSharp patch](../jackett/README.md) adds the two
DataDome handoff steps and tests a locally built, separately versioned NuGet
package. It is not included in an installed Jackett service or the bridge image.

A separate local check uses a deliberately slow fake Moli process to verify that TTL expiration does not interrupt an initializing named session:

```sh
node tools/flaresolverr-contract/check-session-startup-race.mjs
```

To verify that destroying a session does not release capacity while its backend
is still exiting, run `node tools/flaresolverr-contract/check-bridge-capacity.mjs`.
It uses a disposable fake backend that ignores the first termination signal and
checks that a failed process start does not retain capacity.

To verify TTL rotation at a one-process limit, including slow exits, concurrent
calls, proxy preservation, timeout, destroy and disconnect, run:

```sh
MOLI_TEST_BINARY=/absolute/path/to/moli node tools/flaresolverr-contract/check-session-ttl-capacity.mjs
MOLI_TEST_BINARY=/absolute/path/to/moli node tools/flaresolverr-contract/check-session-ttl-races.mjs
```

To check API-client disconnects, run:

```sh
MOLI_TEST_BINARY=/absolute/path/to/moli node tools/flaresolverr-contract/check-bridge-disconnect.mjs
node tools/flaresolverr-contract/check-bridge-startup-disconnect.mjs
```

These tests use a loopback fixture and disposable processes. They check that an
active request retires its backend, a queued request never navigates and leaves
the active session intact, a temporary startup is retired, and a waiting
client cannot interrupt a shared named session while it starts.

## External CDP URL parameters

`check-cdp-query.mjs` connects to a disposable CDP endpoint and compares its page-observable timezone, locale, platform, browser brand, and hardware concurrency with those specified in the endpoint URL. It exits nonzero for mismatches. It uses the Playwright dependency installed in `flaresolverr-bridge`. For example:

```sh
node tools/flaresolverr-contract/check-cdp-query.mjs 'http://127.0.0.1:9222?timezone=Asia%2FShanghai&locale=zh-CN&platform=windows&brand=Edge&hardware-concurrency=10'
```

Moli itself ignores these query parameters; the experimental gateway applies them during attachment. Connecting successfully is not evidence that the requested values took effect. Do not point this check at a production browser: it opens a page and closes its Playwright connection.

To check the underlying CDP emulation commands independently, run `node tools/flaresolverr-contract/check-cdp-overrides.mjs http://127.0.0.1:9222`. This tests page-observable timezone, locale, language, platform, UA and hardware concurrency; it does not implement or test URL parameter handling or GPU identity.

Run `node tools/flaresolverr-contract/check-cdp-gateway.mjs http://127.0.0.1:9222` against a disposable gateway to verify invalid parameters, independent concurrent profiles, headers, page startup scripts, navigation, dedicated workers, locale transfer, and browser close behavior. This test does not establish the required resource and network isolation between services.

Run `node --test flaresolverr-bridge/cdp-profile.test.mjs` for profile parsing and defaults, and `node tools/flaresolverr-contract/check-cdp-profile.mjs http://127.0.0.1:9222` against a disposable gateway for native device metrics, geolocation, touch, UA metadata, media settings, offline/JavaScript settings, resource loading and HTTP proxy behavior. The fixture assumes the gateway can reach loopback on the machine running the test.

## RSSHub CDP compatibility

Against a disposable gateway, test the `patchright` version and Browserless-style launch payload used by RSSHub commit `8f71938d4b9b032cab5712788d5ca8f4f327917c`:

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix /tmp/moli-rsshub-patchright --no-save patchright@1.64.3
RSSHUB_PATCHRIGHT_PATH=/tmp/moli-rsshub-patchright/node_modules/patchright/index.mjs node tools/flaresolverr-contract/check-rsshub-cdp.mjs http://127.0.0.1:9222
node tools/flaresolverr-contract/check-rsshub-abort.mjs
```

The first check exercises HTTP discovery and direct WebSocket, distinct contexts, user agent, JavaScript, CDP Fetch replay and redirect blocking, per-launch proxy, and closing one of two clients. The second uses fake slow backends to check cleanup when a WebSocket or HTTP discovery client disconnects during startup, verifies that a terminating process retains its capacity slot until it exits, and checks invalid discovery and failed process starts. These do not establish complete RSSHub route compatibility, external CDP resource isolation, or successful anti-bot handling.
