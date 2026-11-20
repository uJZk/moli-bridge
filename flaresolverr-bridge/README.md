# Moli FlareSolverr bridge prototype

A local `/v1` service using the pinned open-source `playwright-core` CDP client and a separate Moli process per session. It is a development prototype, not yet a FlareSolverr replacement for protected sites. In particular it has not passed the complete MoviePilot sign-in flow. The default container also runs the CDP gateway; both endpoints share container resources and a network namespace.

The bridge incorporates code adapted from TRAWL under AGPL-3.0-only; see [the upstream notice](upstream/TRAWL-NOTICE.md) and [license](upstream/TRAWL-LICENSE). Network operators and distributors must provide the corresponding source as required by the license. Moli and other included components retain their own licenses.

Requires Node.js 22 or later and a Moli executable with `serve --port 0`. Install dependencies and start from this directory:

```sh
npm ci
MOLI_BIN=/path/to/moli npm start
```

The API listens on `127.0.0.1:8191` by default. `BRIDGE_HOST`, `BRIDGE_PORT` and `BRIDGE_MAX_SESSIONS` configure the listener and process limit. The process limit must be a positive safe integer; an invalid value prevents startup instead of silently disabling the limit. `MOLI_USER_AGENT` optionally passes a fixed `--user-agent` to every bridge backend; the resulting browser UA is returned in `solution.userAgent`. Do not change it during a session that depends on clearance cookies.

When a FlareSolverr request supplies no overrides, the current Moli source profile reports Windows/Chrome, `en-US`, a 1920×1080 viewport and screen, device pixel ratio 1, 8 hardware threads, 8 for `navigator.deviceMemory`, and `navigator.webdriver` false. These native defaults also apply to other Moli entry points unless explicitly overridden. For both the bridge and CDP gateway, if the service process timezone resolves to UTC, the backend defaults to `America/Los_Angeles` (including daylight saving time); otherwise it inherits the service timezone. An explicit CDP `timezone` parameter takes precedence. This timezone rule is applied by the bridge and gateway launchers, not by standalone Moli. The exposed memory value is a coarse browser profile value, not a report of the host's actual RAM. Changing these values alone does not establish Cloudflare compatibility. The `/v1` API does not expose per-request configuration for the full native profile; the CDP gateway's query parameters apply only to the separate gateway.

Destroyed or timed-out sessions disappear from the session list immediately, but their backend processes continue to count against the limit until they exit. The bridge sends `SIGKILL` after two seconds if a process has not exited. The endpoint process limits do not reserve CPU or memory between them.

If the API client disconnects during an active `request.get` or `request.post`, the bridge retires that request's backend process, including a named session and its stored state. A disconnected request that is still queued is discarded without interrupting the running request. An abandoned temporary session is also retired during startup; a shared named session that is still starting is kept for other callers. Explicit session-management commands retain their existing semantics.

Implemented commands: `sessions.create`, `sessions.list`, `sessions.destroy`, `request.get` and `request.post`. Named sessions retain state and use the proxy supplied at creation; unnamed requests use temporary processes. GET/POST, request headers, cookies, `maxTimeout`, `session_ttl_minutes`, `returnOnlyCookies`, `returnScreenshot`, `waitInSeconds` and `disableMedia` have prototype support. The upstream FlareSolverr challenge detection patterns and its keyboard and verify-button interaction are adapted under MIT in `upstream/`. Detected challenges are waited for and verification is attempted while the request deadline permits. Cloudflare challenge headers and AWS WAF challenge responses are treated as challenges even when titles are ordinary; an explicit AWS WAF CAPTCHA response returns an error because no AWS CAPTCHA solver is integrated. `tabs_till_verify` supports 0–100 Tab presses for GET requests and returns a changed `cf-turnstile-response` value as `solution.turnstile_token`; if the field is absent the value is null. Real Turnstile success remains unverified. Known blocked pages return an error. Challenge detection is not exhaustive, and a successful response does not establish challenge clearance.

For explicit `tabs_till_verify` requests with at least one Tab, the bridge temporarily sets `tabindex="-1"` on hidden inputs in the main document, then restores their previous attributes if they still have that value. This works around Moli 1.1.26 incorrectly including hidden inputs in sequential focus; the generic-button and multiple-Tab paths are checked against that release with a local fixture. The mutation can be observed by page scripts, and does not cover inputs in shadow roots or child frames. It is not applied to the automatic challenge-frame fallback.

The automatic keyboard fallback confirms that focus is on a recognized HTML challenge iframe before pressing Space. The official Moli 1.1.26 release does not move focus into the child document or deliver Space to its control in the local fixture. The workspace source now handles frame focus traversal and keyboard delivery; a locally built AMD64 executable passed the fixture, nested and empty-frame cases, visibility checks, and a local Chromium comparison. It also passed a local TLS cross-origin keyboard challenge. This does not establish success against a live challenge or on other architectures. Run `MOLI_TEST_BINARY=/path/to/moli node tools/flaresolverr-contract/check-iframe-keyboard.mjs` from the repository root to inspect keyboard delivery; add `CHROMIUM_TEST_BINARY=/path/to/chromium` for the control and `--expect-fixed` for a build expected to support it. `check-frame-tab-order.mjs` additionally checks Tab ordering, reverse navigation and hidden frames.

`request.get` rejects a non-null `postData` field, as FlareSolverr does. `request.post` requires a string `postData`, including an empty string for an empty body. Both checks run before a new browser session is started.

For HTML up to 256 KiB, active AWS WAF configuration and challenge scripts can also identify an interstitial without the action header. Successful HTTP responses must have a lean body; the heuristic excludes tested ordinary pages with visible content. A detected CAPTCHA returns an error; an automated script challenge is observed until it clears or the request times out. This evidence does not authorize POST replay and is verified only with local fixtures; other page shapes can still be misclassified or missed.

Cloudflare `/cdn-cgi/error/` pages return an access-denied error. Query-only `error=1015` and `error=1020` are treated as blocks only on HTTP 403 or 429 responses with Cloudflare response evidence; ordinary successful pages with those query parameters remain valid.

The DataDome `x-dd-b` response header is treated as challenge evidence, following TRAWL; `x-datadome` alone is not. For HTML up to 256 KiB, an active DataDome `dd` object with `t: 'bv'` and a provider hostname on an HTTP 403 or 429 response produces an explicit hard-block error. On an explicitly identified Device Check, a new or changed nonempty `datadome` cookie that remains stable for three seconds can trigger one same-origin GET to the original URL. That attempt shares the limit of one recovery across all challenge types; interactive CAPTCHAs and POST requests do not trigger it. The bridge does not solve a DataDome CAPTCHA or use these signals to authorize POST replay. This behavior has only been checked with local fixtures and can miss or misclassify other page formats.

For HTML up to 256 KiB, active DDoS-Guard interstitial identifiers and script sources are also treated as challenge evidence, even if the title is ordinary. The bridge waits for them to disappear within the request deadline; a generic provider mention or server header alone is not evidence. This detection does not authorize POST replay and has only been verified with local fixtures, not a real DDoS-Guard challenge.

The bridge tracks main-frame navigation while loading and collecting a response. If an initial navigation is reported as interrupted, it continues only when a replacement main-frame request was observed; failures of that replacement remain errors. Before returning, it observes a 500 ms quiet window and repeats its checks after each navigation or reload. This adds at least 500 ms to an otherwise immediately ready response and cannot predict redirects scheduled after the window; callers can use `waitInSeconds` when a longer wait is needed. All navigation and challenge work shares the request's overall timeout.

After `DOMContentLoaded`, the bridge waits up to two seconds for the full `load` event once per document, then continues checking the page even if a subresource is stalled. It still waits for detected challenges and navigation within the overall deadline. A page that populates content or navigates later than these waits may need `waitInSeconds`; a script that blocks `DOMContentLoaded` can still exhaust the request timeout. If the overall deadline expires after session startup, the error identifies the last stage, such as initial navigation, challenge clearance or result collection, without including page URLs or cookies. The stage is diagnostic and does not by itself identify the underlying cause.

For a disposable reproduction, set `BRIDGE_DIAGNOSTICS=1` on the bridge and capture its stderr or container logs. For the supplied Compose file, recreate the service with `BRIDGE_DIAGNOSTICS=1 docker compose -f flaresolverr-bridge/compose.yaml up -d --no-build`, reproduce once, and retrieve `docker compose -f flaresolverr-bridge/compose.yaml logs --since 5m moli | grep bridge-diagnostic`. To turn diagnostics off, recreate it with `BRIDGE_DIAGNOSTICS=0`. Recreating the service interrupts active sessions. Events contain an ephemeral request identifier, elapsed time, phases, categorized navigation/Cloudflare resource statuses, resource failures, page-error types, challenge recognition and verification outcomes. When enabled, a document-start listener also records error types from window error events, including synchronous inline exceptions that the current Moli CDP path does not always emit as `pageerror`. This listener is observable by the page and may miss errors; the same error can appear as both `window-error` and `page-error`. Missing error events do not prove scripts succeeded. `newCookieObserved` indicates whether the recovery logic saw a new matching clearance cookie, not its value. At most 200 records are emitted per request; URLs, headers, page text, cookie values and exception messages are excluded. Review logs before sharing them. Diagnostics are off by default and do not establish why a provider rejected a browser.

For main-frame requests, `navigation-cookie` records whether the request headers exposed by CDP contain an absent, empty or nonempty `cf_clearance` cookie; `unavailable` means the headers could not be read. The navigation number also appears on its response event. This is CDP's view of the request, not independent wire capture or proof that the server accepted the cookie. A `recovery-attempt` event identifies when the bridge itself initiates its single recovery navigation; other navigations can be initiated by the page. No cookie value or destination is recorded.

For HTML up to 256 KiB, the bridge also recognizes short meta-refresh redirects (up to 10 seconds) and waits for the browser to perform them, with two seconds of additional grace and the same overall timeout. It reports an error if the advertised navigation does not occur. It does not force a navigation or replay a POST; same-URL refreshes, longer delays and refreshes in larger documents are not covered by this detection.

For a GET that remains on a Cloudflare challenge, a new, nonempty `cf_clearance` cookie that stays present for five seconds can trigger one return to the original same-origin URL. An empty cookie or a cookie already present before navigation does not trigger recovery, and POST requests are never automatically replayed by this recovery path.

For a detected DDoS-Guard challenge, a new `__ddg2_` or `__ddg5_` cookie that remains present for eight seconds can likewise trigger one same-origin GET to the original URL. Recovery attempts across both challenge types share a limit of one per request. Existing cookies and POST requests do not trigger this recovery. This behavior follows a restricted form of TRAWL's DDoS-Guard waiter and has only been verified with local fixtures.

The challenge flow also tries native and ARIA checkbox controls inside HTTPS `challenges.cloudflare.com` frames and same-origin `/cdn-cgi/challenge-platform/` frames. Accessible controls use normal browser actionability checks so an overlay cannot receive a forced click. For closed shadow roots, CDP inspection limits the search to the recognized frame and checks that the checkbox is connected, enabled and unchecked. The hit test must identify the checkbox itself, or a verified noninteractive descendant of an ARIA checkbox. Automatic keyboard fallback only presses Space when focus is confirmed inside a recognized challenge frame. Local TLS fixtures exercise cross-origin open and closed shadow roots, checked and disabled controls, overlays and interactive descendants; they do not contact Cloudflare or establish real Turnstile clearance. Explicit `tabs_till_verify` remains a caller-directed keyboard action.

When `session_ttl_minutes` expires while a named session is starting or executing a request, rotation returns a busy error instead of terminating the in-flight process. Retry after the other operation completes. For an idle expired session, the bridge waits for the old process to exit within the request timeout, then recreates the session with its existing proxy. Other calls for that session receive a busy error while it rotates. If the wait for the old process times out or the client disconnects before replacement starts, the old session is removed and no replacement is started. Once a replacement named session has begun starting, it follows the shared-startup behavior described above.

For `request.post`, the bridge guards subsequent main-frame POST navigations to the original URL: a replay is allowed only after that submission receives an explicit `cf-mitigated: challenge` or AWS WAF `202`/`x-amzn-waf-action: challenge` response, or recognized active Cloudflare/Anubis HTML challenge evidence. HTML inspection requires an HTML content type, a declared length at most 256 KiB and a decoded body no larger than 256 KiB. Otherwise the bridge aborts it and returns an error. This adapts a subset of TRAWL's replay guard: other destinations, unrecognized or unbounded HTML evidence, and arbitrary page-initiated side effects are not covered, and the bridge does not initiate a replay itself.

The service accepts arbitrary HTTP(S) targets and has no authentication. Keep it on a trusted network. Proxy `username` and `password` fields are plain strings; credentials embedded directly in a proxy URL must use URL encoding for reserved characters. The `socks5h` alias is normalized to SOCKS5, which sends the target hostname to the proxy. Proxy credentials are passed to the Moli subprocess as command-line arguments and may be visible to users with process inspection access. Backend CDP listeners are on loopback and can be reached by other processes in the same container.

Run the acceptance tests described in [tools/flaresolverr-contract](../tools/flaresolverr-contract/README.md). A local fixture pass does not verify CAPTCHA solving, the site's anti-bot checks, or the plugin's independent browser/direct POST paths. See [the investigation](../docs/flaresolverr-bridge-investigation.md) for the upstream choices and outstanding work.

See the [upstream sources and synchronization guide](../docs/UPSTREAMS.md) for dependency versions, licenses, and update procedures.

## Container build and use

The default `MOLI_MODE=both` runs the bridge and CDP gateway in one container.
Each endpoint starts its own Moli processes, but they share the container's CPU,
memory, PID and network boundaries. Compose binds both ports to `127.0.0.1` by
default. Neither endpoint has authentication; use a trusted, authenticated
perimeter before exposing either port. `MOLI_MODE=bridge` and `MOLI_MODE=cdp`
remain available for deployments that need only one endpoint.

To build locally on Linux AMD64, install the pinned Rust toolchain and the
native build dependencies (including CMake, libclang and LLD), then run from the
repository root:

```sh
CARGO_PROFILE_DEV_DEBUG=0 \
  RUSTFLAGS='-C link-arg=-fuse-ld=lld -C link-arg=-Wl,--no-pie -C link-arg=-Wl,--icf=safe' \
  cargo build --locked -p moli
MOLI_SOURCE_BINARY="$PWD/target/debug/moli" ./scripts/prepare-bridge-container.sh
MOLI_BRIDGE_IMAGE=moli-bridge:local docker compose -f flaresolverr-bridge/compose.yaml up -d --build
```

On a Linux ARM64 host, build for the native architecture with
`RUSTFLAGS='-C link-arg=-fuse-ld=lld'`, then pass the resulting executable as
`MOLI_SOURCE_ARM64_BINARY` instead. The ARM64 path was built in CI but was not
run in this verification.

The preparation step downloads the official Moli 1.1.26 AMD64 and ARM64 release
archives and checks pinned SHA-256 hashes. It installs the lockfile-pinned pure JS
dependencies in the ignored `.container-assets` directory. If `MOLI_SOURCE_BINARY`
is set, the AMD64 image embeds that Linux AMD64 executable in place of the
upstream binary. `MOLI_SOURCE_ARM64_BINARY` does the same for ARM64. If either
variable is omitted, that architecture uses the official release. Release CI
supplies both binaries built from the current checkout.
Use `MOLI_RELEASE_CACHE_DIR` to reuse
previously downloaded `moli-1.1.26-amd64.tar.gz` and `moli-1.1.26-arm64.tar.gz`.

To use a Moli executable built from this workspace instead, pass the optional
Compose override and an absolute path to the executable:

```sh
MOLI_SOURCE_BINARY=/absolute/path/to/moli \
  docker compose -f flaresolverr-bridge/compose.yaml \
  -f flaresolverr-bridge/compose.source.yaml up -d --build
```

The override bind-mounts that file read-only at `/opt/moli/moli` in the
container. The bridge and CDP gateway still launch separate Moli processes.
The executable must be a Linux binary for the
container architecture, executable by the container's `node` user, and
compatible with the image's runtime libraries. Mount the same exact build
used for testing; replacing a bind-mounted file requires recreating the
container. The mount replaces whichever Moli binary was included at image build.

Before using the override, the executable and image can be checked in two
disposable containers without external networking:

```sh
./tools/flaresolverr-contract/check-source-container.sh /absolute/path/to/moli moli-bridge:local
```

This covers the bridge's local navigation and keyboard challenge, plus the
CDP role's iframe keyboard interaction. It does not verify target-site
challenges or the host's resource limits.

Check the local image with:

```sh
MOLI_BRIDGE_IMAGE=moli-bridge:local ./scripts/smoke-bridge-container.sh
```

The script starts one disposable service, checks both endpoints, restarts it and
repeats the checks. Sessions are in memory and are lost on restart. `BRIDGE_PORT`,
`CDP_PORT`, `MOLI_MEMORY_LIMIT` and `MOLI_CPU_LIMIT` can be set for Compose.

### GitHub Actions and deployment

The [`Experimental container` workflow](../.github/workflows/container.yml) builds Moli from the
checkout for both AMD64 and ARM64 and smoke-tests the AMD64 image before
publishing the multi-architecture `ghcr.io/ujzk/moli-bridge:latest` image. The
ARM64 image is not smoke-tested by this workflow. Pushes to `main` that change
the listed build inputs trigger it automatically; documentation-only changes do
not. To run it manually, select **Actions → Experimental container → Run
workflow**, choose `main`, or use an authenticated GitHub CLI:

```sh
gh workflow run container.yml --ref main
gh run list --workflow container.yml --branch main --limit 5
```

A manual run also publishes `latest` after the checks pass. The workflow needs
package write permission to push to GHCR and then verifies that both published
platforms carry the expected `org.opencontainers.image.revision` label. Inspect
the run before treating a new image as published: the final registry check runs
after the push. The revision records the source commit used to build the image,
which can precede a later documentation-only commit.

To inspect and deploy the published image from the repository root:

```sh
docker buildx imagetools inspect ghcr.io/ujzk/moli-bridge:latest
docker compose -f flaresolverr-bridge/compose.yaml pull
docker image inspect ghcr.io/ujzk/moli-bridge:latest \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
docker compose -f flaresolverr-bridge/compose.yaml up -d --no-build
```

Compose exposes the Bridge on host loopback port `8191` and CDP on `9222` by
default. A Jackett or RSSHub process in another container needs an appropriate
network route: its own `127.0.0.1` refers to that container. Neither endpoint
authenticates clients, so restrict access to trusted clients.

The image is experimental; the `latest` tag does not denote a stable release.
Pulling `ghcr.io/ujzk/moli-bridge` without an explicit tag selects `latest`.

## RSSHub CDP connection

RSSHub's `PLAYWRIGHT_CDP_ENDPOINT` can point to the gateway's HTTP root, for example `http://127.0.0.1:9222`, or a direct WebSocket such as `ws://127.0.0.1:9222/chromium`. RSSHub must be able to reach that address from its own network namespace. This has been checked against the `patchright` client and launch format used by RSSHub commit `8f71938d4b9b032cab5712788d5ca8f4f327917c`; it is not a claim that every RSSHub route works.

At the pinned RSSHub revision, the Worker fetch wrapper invokes the targeted API retry only when `PLAYWRIGHT_WS_ENDPOINT` is set; the ordinary Node wrapper does not invoke it. [Optional source patches](../tools/rsshub/README.md) enable CDP and separately connect the retry to the Node wrapper. They must be applied when building RSSHub and do not change a running installation automatically.

The patched RSSHub page and retry modules have also been exercised together with Patchright and a Moli gateway using local TLS fixtures, including GET and form replay, redirect rejection and cancellation. A separate optional UPS route patch works around a Moli 1.1.26 dynamic table layout issue; see the [patch notes](../tools/rsshub/README.md). These checks do not test the user's RSSHub deployment or live endpoints.

An additional Moli-specific optional RSSHub patch enables authenticated HTTP, HTTPS and SOCKS5 proxies over this CDP gateway; unpatched RSSHub instead skips authenticated proxies in CDP mode. The patch is not for other CDP providers. HTTPS proxy certificates must be trusted by Moli. Proxy credentials travel in the CDP connection query and the Moli process arguments, which may be exposed in network/access logs or to local process inspectors; see the [patch notes](../tools/rsshub/README.md) before using it.

The gateway accepts RSSHub's Browserless `launch` JSON, including its default sandbox/window flags, `headless: true` and `--proxy-server=...`. `stealth: true` maps to Moli's automation override (`navigator.webdriver` false); it does not provide all Browserless or Patchright stealth behavior. Unknown launch flags, PAC proxy arguments, authentication tokens in the query string, and non-headless mode are rejected. The endpoint itself has no authentication; keep it in a trusted network or behind an authenticated perimeter. Browserless' Playwright protocol (`PLAYWRIGHT_WS_ENDPOINT`) is not supported by this CDP gateway.

## Experimental CDP query gateway

The gateway is a separate executable and starts a fresh Moli process for each Playwright CDP connection. In the default deployment it shares a container and resource limits with the bridge. The gateway itself has no authentication. It listens on loopback by default when started directly.

```sh
npm ci
MOLI_BIN=/path/to/moli npm run cdp
```

`CDP_HOST`, `CDP_PORT` and `CDP_MAX_BROWSERS` configure the listener and connection limit (defaults `127.0.0.1`, `9222`, and `8`). The limit must be a positive safe integer; an invalid value prevents startup. Use an HTTP URL with Playwright `connectOverCDP`; the query is read during `/json/version` discovery. The discovery URL and browser WebSocket are one-use and the browser process is stopped on disconnect. URL-encode query values as needed:

Abandoning HTTP discovery or a direct WebSocket while the backend is starting closes that backend. A stopped backend continues to count against `CDP_MAX_BROWSERS` until its process exits; the gateway sends `SIGKILL` after two seconds if it has not exited. An unused successful discovery is closed after 30 seconds. The limit does not reserve CPU or memory for the bridge.

```text
http://127.0.0.1:9222?timezone=Asia%2FShanghai&locale=zh-CN&platform=windows&brand=Edge&hardware-concurrency=10
```

All parameters are optional. An omitted, empty, or whitespace-only value uses the default; explicit `false` and `0` retain their meaning. Unknown, duplicate and invalid parameters return HTTP 400. Unless stated otherwise, omission preserves Moli's native default. Percent-encode reserved characters in values, particularly proxy URLs with `&` or credentials.

| Parameter | Values and defaults |
| --- | --- |
| `timezone` | IANA timezone such as `Asia/Shanghai`; default: `America/Los_Angeles` if the gateway process timezone resolves to UTC, otherwise the gateway process timezone. Requires timezone data. |
| `locale` | BCP 47 locale such as `zh-CN`; default: Moli locale (`en-US` in the tested build). Also supplies the default `Accept-Language`. |
| `platform` | `windows`, `linux`, `macos`; default: inferred from an explicit recognizable UA, otherwise Moli's Windows profile. |
| `brand` | `Edge`, `Chrome`, `Chromium`; default: inferred from an explicit Edge UA, otherwise Moli's Chrome profile. |
| `user-agent` | Exact UA string; default: Moli UA adjusted to the requested platform, brand and version. An explicit UA is not rewritten. |
| `accept-language` | Exact HTTP language header; default: `locale` when provided, otherwise Moli's native header. Also affects `navigator.language(s)`. |
| `browser-version` | One to four numeric components; default: Chrome version from the explicit UA or Moli. Controls generated UA and Client Hints; an explicit UA is not rewritten. |
| `platform-version` | Client Hints platform version; default: `19.0.0` for Windows and empty for other platforms when constructing an override. |
| `architecture`, `bitness` | Client Hints architecture `x86` or `arm`, and bitness `32` or `64`; defaults `x86` and `64` when constructing an override. |
| `model`, `wow64` | Client Hints model string and boolean WoW64 indicator; defaults empty and `false` when constructing an override. |
| `form-factors` | Comma-separated Client Hints form factors, such as `Desktop,Tablet`; default: Moli's native `Desktop`. This changes the hint only; mobile device emulation remains unsupported. |
| `ua-brands`, `ua-full-version-list` | URL-encoded JSON arrays of `{ "brand": "...", "version": "..." }`; defaults are generated from the selected brand and browser version. |
| `hardware-concurrency` | Integer 1–256; default: Moli's 8 in the current source profile. |
| `viewport-width`, `viewport-height` | Positive integer CSS pixels up to 100000. Default: Moli's 1920×1080, reduced to fit an explicitly smaller screen. |
| `screen-width`, `screen-height` | Positive integer CSS pixels up to 100000. Default: at least 1920×1080, enlarged to fit an explicitly larger viewport. An explicit viewport cannot exceed the screen. |
| `device-scale-factor`, `viewport-scale` | Numbers from 0.1 to 10; each defaults to 1 when device metrics are overridden. |
| `screen-orientation` | `portrait-primary`, `portrait-secondary`, `landscape-primary`, `landscape-secondary`; default: primary orientation inferred from screen dimensions. |
| `screen-orientation-angle` | Integer 0–359 degrees; default: 0 for primary and 180 for secondary orientation. |
| `position-x`, `position-y` | Nonnegative integer screen coordinates not greater than the corresponding screen dimension; default 0 when device metrics are overridden. |
| `touch`, `max-touch-points` | Boolean touch emulation and 0–16 touch points; default disabled / 0. `touch=true` without a count uses 1; contradictory settings are rejected. |
| `latitude`, `longitude` | Decimal coordinates; no default location is fabricated. Both are required when any location field is set. A caller must independently grant the origin geolocation permission. |
| `accuracy` | Nonnegative meters; default 100 when coordinates are provided. |
| `altitude`, `altitude-accuracy`, `heading`, `speed` | Optional geolocation values; default unavailable. Altitude accuracy and speed are nonnegative; heading is in [0, 360). |
| `media` | `screen` or `print`; default: browser/client media setting. |
| `color-scheme` | `light` or `dark`; default: browser/client setting. |
| `reduced-motion`, `reduced-transparency` | `reduce` or `no-preference`; default: browser/client setting. |
| `forced-colors` | `active` or `none`; default: browser/client setting. |
| `contrast` | `more`, `less`, `no-preference`, `custom`; default: browser/client setting. |
| `proxy` | HTTP, HTTPS, SOCKS4, SOCKS5 or SOCKS5H URL; SOCKS5H is normalized to SOCKS5. Default: Moli's network configuration including applicable environment variables. Explicit proxy disables bypass unless `proxy-bypass` is set. |
| `proxy-bypass` | Moli's comma-separated bypass list; default: Moli's native/environment setting without an explicit proxy, or empty with one. |
| `data-saver`, `automation` | Boolean overrides for `navigator.connection.saveData` and automation state (`navigator.webdriver`); default: Moli native state, normally `false`. |
| `javascript` | Boolean; default enabled. `false` disables page JavaScript. |
| `focus-emulation` | Boolean; default: Moli/Playwright behavior. `false` disables forced focus; it does not force `document.hasFocus()` to be false. |
| `emit-touch-for-mouse` | Boolean; default: Moli native state. Controls emitting touch events for mouse input. |
| `scrollbars` | `visible` or `hidden`; default hidden in the gateway's `--layout` configuration. |
| `offline` | Boolean; default online. `true` makes browser network requests fail as offline. |
| `bypass-service-worker` | Boolean; default: browser/client setting. |
| `layout` | Boolean; default `true`. When `false`, real layout and screenshots are unavailable; `scrollbars` cannot be specified. |
| `subframes` | Boolean; default `true`. `false` starts Moli with subframes disabled. |
| `load-resources` | Boolean; default `true`. Sets the default for optional resource families below. |
| `load-images`, `load-fonts`, `load-audio`, `load-video`, `load-media`, `load-text-tracks` | Booleans; each defaults to `load-resources`, or `true` if that parameter is omitted. Individual values take precedence. |

Booleans accept `true`, `false`, `1`, or `0` (case-insensitive). Media and focus options are initial defaults: subsequent explicit CDP/Playwright commands may change them. Some combinations can create inconsistent identities, such as an explicit UA that conflicts with platform or Client Hints; callers are responsible for consistency. Proxy URLs, including credentials, appear in the Moli subprocess command line and can be visible to local process inspectors.

Only the options in the table are documented for this gateway. Arbitrary document-start scripts, cookie/profile paths, certificates and file paths are not exposed as URL parameters.

The current checks cover pages, same-origin frames and a dedicated worker; other browser surfaces and every possible worker lifecycle have not been established. CDP commands issued by the client can override these settings. A successful local fingerprint check is not evidence that a protected site will accept the browser.

The gateway supports the HTTP discovery form shown above and flat CDP sessions as used by Playwright `connectOverCDP`. RSSHub-style direct WebSocket URLs and launch parameters are tested; remote TLS termination, all CDP clients and reconnection to a previously disconnected browser have not been validated. See [the CDP checks](../tools/flaresolverr-contract/README.md).
