# FlareSolverr compatibility checks

This is an executable acceptance test for a bridge under development. It uses Python 3's standard library and a local HTTP fixture. It exercises session creation/list/deletion, isolated and retained cookies, POST data, HTTP status, `returnOnlyCookies`, an invalid command, and a deadline. It also extracts and executes the real `fs_create_session`, `fs_get`, `fs_call` and cleanup helpers from the MoviePilot plugin to verify its cookie and header handoff. The plugin source is read locally and is not vendored.

The reference plugin revision is `7c7d1036423f3e7350f307c7ad87bd6d2044712a`. Obtain and check it, then run against a bridge that is already running:

```sh
curl -fsSL https://raw.githubusercontent.com/Vivitoto/MoviePilot-Plugins/7c7d1036423f3e7350f307c7ad87bd6d2044712a/plugins.v3/sehuatangsignin/captcha_server.py -o /tmp/moli-moviepilot-captcha.py
printf '%s  %s\n' 6fc4af7553939e03347cf52b1f290cbe2fb1e8aeec7889b3ec6c987410c5e758 /tmp/moli-moviepilot-captcha.py | sha256sum -c
python3 tools/flaresolverr-contract/check.py --endpoint http://127.0.0.1:8191/v1 --moviepilot-source /tmp/moli-moviepilot-captcha.py
```

The browser backend must be able to connect to the fixture. For a bridge in another container or host, use `--listen 0.0.0.0 --fixture-host <reachable-host> --fixture-port <port>` and configure the network accordingly. Do not expose this test fixture on an untrusted network. The endpoint must be a disposable test instance: tests create and destroy sessions.

Add `--test-proxy` to start a fixture-only HTTP proxy and exercise the plugin's proxy configuration. Use a non-loopback `--fixture-host` reachable by the bridge: browsers commonly bypass proxies for loopback destinations. The proxy binds another ephemeral port, which must also be reachable from the bridge. The check is skipped unless explicitly enabled; a run with that skip does not establish required proxy compatibility.

Passing these checks is necessary but not sufficient for MoviePilot compatibility. They do not test session expiry, proxy authentication, screenshots, protected websites, plugin Playwright/browser/direct POST paths, or isolation from the external CDP service. A success against a mock is a test of the harness only. The plugin uses additional browser and direct HTTP paths outside the FlareSolverr API; see [the investigation](../../docs/flaresolverr-bridge-investigation.md).

## External CDP URL parameters

`check-cdp-query.mjs` connects to a disposable CDP endpoint and compares its page-observable timezone, locale, platform, browser brand, and hardware concurrency with those specified in the endpoint URL. It exits nonzero for mismatches. It uses the Playwright dependency installed in `flaresolverr-bridge`. For example:

```sh
node tools/flaresolverr-contract/check-cdp-query.mjs 'http://127.0.0.1:9222?timezone=Asia%2FShanghai&locale=zh-CN&platform=windows&brand=Edge&hardware-concurrency=10'
```

Moli itself ignores these query parameters; the experimental gateway applies them during attachment. Connecting successfully is not evidence that the requested values took effect. Do not point this check at a production browser: it opens a page and closes its Playwright connection.

To check the underlying CDP emulation commands independently, run `node tools/flaresolverr-contract/check-cdp-overrides.mjs http://127.0.0.1:9222`. This tests page-observable timezone, locale, language, platform, UA and hardware concurrency; it does not implement or test URL parameter handling or GPU identity.

Run `node tools/flaresolverr-contract/check-cdp-gateway.mjs http://127.0.0.1:9222` against a disposable gateway to verify invalid parameters, independent concurrent profiles, headers, page startup scripts, navigation, dedicated workers, locale transfer, and browser close behavior. This test does not establish the required resource and network isolation between services.

Run `node --test flaresolverr-bridge/cdp-profile.test.mjs` for profile parsing and defaults, and `node tools/flaresolverr-contract/check-cdp-profile.mjs http://127.0.0.1:9222` against a disposable gateway for native device metrics, geolocation, touch, UA metadata, media settings, offline/JavaScript settings, resource loading and HTTP proxy behavior. The fixture assumes the gateway can reach loopback on the machine running the test.
