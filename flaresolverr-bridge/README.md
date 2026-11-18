# Moli FlareSolverr bridge prototype

A local `/v1` service using the pinned open-source `playwright-core` CDP client and a separate Moli process per session. It is a development prototype, not yet a FlareSolverr replacement for protected sites. In particular it has not passed the complete MoviePilot sign-in flow. An experimental CDP gateway is provided separately; the required resource and control-plane isolation between it and bridge backends is not yet implemented or verified.

Requires Node.js 22 or later and a Moli executable with `serve --port 0`. Install dependencies and start from this directory:

```sh
npm ci
MOLI_BIN=/path/to/moli npm start
```

The API listens on `127.0.0.1:8191` by default. `BRIDGE_HOST`, `BRIDGE_PORT` and `BRIDGE_MAX_SESSIONS` configure the listener and process limit. `MOLI_USER_AGENT` optionally passes a fixed `--user-agent` to every bridge backend; the resulting browser UA is returned in `solution.userAgent`. Do not change it during a session that depends on clearance cookies.

Implemented commands: `sessions.create`, `sessions.list`, `sessions.destroy`, `request.get` and `request.post`. Named sessions retain state and use the proxy supplied at creation; unnamed requests use temporary processes. GET/POST, request headers, cookies, `maxTimeout`, `session_ttl_minutes`, `returnOnlyCookies`, `returnScreenshot`, `waitInSeconds` and `disableMedia` have prototype support. The upstream FlareSolverr challenge detection patterns are reused under MIT in `upstream/`; detected challenges are waited for, but FlareSolverr's challenge solvers and `tabs_till_verify` are not implemented. Known blocked pages return an error. Challenge detection is not exhaustive, and a successful response does not establish challenge clearance.

The service accepts arbitrary HTTP(S) targets and has no authentication. Keep it on a trusted network. Proxy credentials supplied in a proxy URL are passed to the Moli subprocess as command-line arguments and may be visible to users with process inspection access. Backend CDP listeners are on loopback, but processes on the same host can access them. Per-session processes alone do not provide the resource or control-plane isolation required for a public external Playwright endpoint.

Run the acceptance tests described in [tools/flaresolverr-contract](../tools/flaresolverr-contract/README.md). A local fixture pass does not verify CAPTCHA solving, the site's anti-bot checks, or the plugin's independent browser/direct POST paths. See [the investigation](../docs/flaresolverr-bridge-investigation.md) for the upstream choices and outstanding work.

## Container build and use

The same image has two modes: `MOLI_MODE=bridge` and `MOLI_MODE=cdp`. The supplied
[Compose file](compose.yaml) runs the modes in separate containers, PID and network
namespaces, with separate memory, CPU and PID limits. Both published ports bind
to `127.0.0.1` by default. The services have no authentication; provide a trusted,
authenticated perimeter before exposing either port. These settings require a
Docker runtime with working cgroup limits and network isolation. Resource
exhaustion and hostile-client isolation still need verification on the target host.

Build locally from the repository root:

```sh
./scripts/prepare-bridge-container.sh
MOLI_BRIDGE_IMAGE=moli-bridge:local docker compose -f flaresolverr-bridge/compose.yaml up -d --build
```

The preparation step downloads the official Moli 1.1.26 AMD64 and ARM64 release
archives and checks pinned SHA-256 hashes. It installs the lockfile-pinned pure JS
dependencies in the ignored `.container-assets` directory. The image embeds the
official release binary, its included license notices, and the bridge code; it does
not compile the Moli source in this fork. Use `MOLI_RELEASE_CACHE_DIR` to reuse
previously downloaded `moli-1.1.26-amd64.tar.gz` and `moli-1.1.26-arm64.tar.gz`.

Check the local image with:

```sh
MOLI_BRIDGE_IMAGE=moli-bridge:local ./scripts/smoke-bridge-container.sh
```

The script starts separate disposable
services, checks their health, performs local API and CDP requests, restarts each
service and repeats the checks. Sessions are in memory and are lost on restart.
`BRIDGE_PORT`, `CDP_PORT`, `BRIDGE_MEMORY_LIMIT`, `CDP_MEMORY_LIMIT`,
`BRIDGE_CPU_LIMIT`, and `CDP_CPU_LIMIT` can be set for Compose. Verify actual
runtime enforcement; accepting a limit in Compose is not proof it is enforced.

The `Experimental container` GitHub Actions workflow builds and smoke-tests
AMD64 and ARM64 images before publishing `ghcr.io/ujzk/moli-bridge:edge` and a
commit-specific `sha-<commit>` tag. The ARM64 test uses QEMU. Publication depends
on a successful workflow run and registry permissions; no stable release is
implied by the `edge` tag.

## Experimental CDP query gateway

The gateway is a separate executable and starts a fresh Moli process for each Playwright CDP connection. Run it in an isolated service or container with a network namespace and resource limits distinct from the FlareSolverr bridge. The Compose example configures separate boundaries, but their enforcement and resistance to resource exhaustion must be verified on the deployment host. Separate processes and loopback listeners alone are insufficient isolation. The gateway itself has no authentication. It listens on loopback by default.

```sh
npm ci
MOLI_BIN=/path/to/moli npm run cdp
```

`CDP_HOST`, `CDP_PORT` and `CDP_MAX_BROWSERS` configure the listener and connection limit (defaults `127.0.0.1`, `9222`, and `8`). Use an HTTP URL with Playwright `connectOverCDP`; the query is read during `/json/version` discovery. The discovery URL and browser WebSocket are one-use and the browser process is stopped on disconnect. URL-encode query values as needed:

```text
http://127.0.0.1:9222?timezone=Asia%2FShanghai&locale=zh-CN&platform=windows&brand=Edge&hardware-concurrency=10
```

All parameters are optional. An omitted, empty, or whitespace-only value uses the default; explicit `false` and `0` retain their meaning. Unknown, duplicate and invalid parameters return HTTP 400. Unless stated otherwise, omission preserves Moli's native default. Percent-encode reserved characters in values, particularly proxy URLs with `&` or credentials.

| Parameter | Values and defaults |
| --- | --- |
| `timezone` | IANA timezone such as `Asia/Shanghai`; default: backend process timezone. Requires timezone data. |
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
| `hardware-concurrency` | Integer 1–256; default: Moli's 4 in the tested build. |
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
| `proxy` | HTTP, HTTPS, SOCKS4 or SOCKS5 URL; default: Moli's network configuration including applicable environment variables. Explicit proxy disables bypass unless `proxy-bypass` is set. |
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

The gateway supports the HTTP discovery form shown above and flat CDP sessions as used by Playwright `connectOverCDP`. Direct WebSocket URLs with query parameters, remote TLS termination, all CDP clients and reconnection to a previously disconnected browser have not been validated. See [the CDP checks](../tools/flaresolverr-contract/README.md).
