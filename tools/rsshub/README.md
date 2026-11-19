# Optional RSSHub compatibility patches

RSSHub commit `8f71938d4b9b032cab5712788d5ca8f4f327917c` uses Patchright's
CDP endpoint for page requests, but its targeted browser-fetch retry only
checks whether `PLAYWRIGHT_WS_ENDPOINT` is set. With only
`PLAYWRIGHT_CDP_ENDPOINT`, that retry is not enabled.

`cdp-fetch-retry.patch` changes the gate to accept either endpoint and adds an
upstream regression test. In the pinned version, the helper is called by the
Worker fetch wrapper; the ordinary Node server does not call it. The separate
`node-cdp-fetch-retry.patch` connects the helper to the Node fetch wrapper when
a CDP endpoint is configured. Apply it after `cdp-fetch-retry.patch`.

Node replay remains limited to the Bilibili and Pixiv API paths and response
statuses selected by RSSHub's helper. Requests with a `publicOnly` guard,
custom dispatcher or TLS minimum, disabled HTTP/2, credential-header restrictions,
or an explicit response-size limit remain on the original Node fetch path.
The original request's redirect mode is preserved. The browser helper buffers
the entire replayed response before RSSHub applies its default response-size
limit, so that limit does not bound peak memory during replay. Apply the Node
patch only if that behavior is acceptable for the selected upstream endpoints.

The patches apply to the pinned RSSHub commit; inspect and
rebase it before use with other versions. The patch is AGPL-3.0, like RSSHub,
and is distributed with the license text in
[`TRAWL-LICENSE`](../../flaresolverr-bridge/upstream/TRAWL-LICENSE). This does
not modify an installed RSSHub instance or build an RSSHub image.

`moli-cdp-auth-proxy.patch` is a separate, Moli-specific opt-in patch for the
same RSSHub revision. Upstream RSSHub drops authenticated proxies when it
connects over CDP; the patch passes HTTP, HTTPS and SOCKS5 credentials to the
Moli gateway instead. The `socks5h` alias is normalized to SOCKS5, with target
name resolution performed by the proxy. Authenticated SOCKS4 and SOCKS4a are
rejected in CDP mode. HTTPS proxy certificates must be trusted by Moli; the
local tests explicitly provide their test CA to the Moli executable. This
patch targets the Moli gateway and is not intended for arbitrary Browserless/CDP
providers. Do not apply it unless the CDP endpoint is the Moli gateway.

`socks5-undici-auth.patch` addresses the ordinary Node HTTP fetch path in the
same RSSHub revision. Its Undici 8.12.4 `ProxyAgent` passes URL-encoded SOCKS5
userinfo to the SOCKS client without decoding it, so credentials containing
reserved characters fail. The patch supplies the decoded username and password
explicitly. It is separate from `moli-cdp-auth-proxy.patch`, which only changes
the browser/CDP path; both are needed when a SOCKS5 proxy with such credentials
is used for native fetches and Moli page requests.

The authenticated proxy URL is carried in the CDP connection query and passed
to the Moli subprocess command line. It can therefore be visible in access
logs, network traces and local process inspection. Use an appropriately
protected connection and logging policy. The patch suppresses credential-bearing
connection and context-initialization errors, but does not guarantee that
other components or logs redact credentials.

`moli-ups-dynamic-table.patch` is a separate, optional patch for the same RSSHub
revision. In a local fixture using Moli 1.1.26, table rows inserted after a
button click exist in the DOM but have zero-sized layout rectangles; RSSHub's
UPS route waits for a visible row and times out. The patch waits until every
currently matched row contains the nonempty, index-matched status field used by
the route, and the first row and its ancestors are not hidden. This avoids
parsing a visible loading placeholder that lacks the expected status field.
A placeholder that supplies a nonempty status field can still pass. It requests a 1×1
CDP screenshot to publish current layout, and then applies the original
Playwright visibility check before parsing. It cannot predict rows added after
these checks. The capture is in memory, but it still incurs
a layout and screenshot operation and requires the gateway's layout mode.
This is a route-specific workaround, not a fix to Moli layout. It has only
been tested on local fixtures, not the live UPS site. Apply the patches needed to a compatible
RSSHub source checkout before building that installation, for example:

```sh
git -C /path/to/RSSHub apply /path/to/moli-bridge/tools/rsshub/cdp-fetch-retry.patch
# For targeted browser retries in the ordinary Node server:
git -C /path/to/RSSHub apply /path/to/moli-bridge/tools/rsshub/node-cdp-fetch-retry.patch
git -C /path/to/RSSHub apply /path/to/moli-bridge/tools/rsshub/moli-ups-dynamic-table.patch
# Only when the CDP endpoint is the Moli gateway and authenticated proxy support is needed:
git -C /path/to/RSSHub apply /path/to/moli-bridge/tools/rsshub/moli-cdp-auth-proxy.patch
# For native Node fetches through authenticated SOCKS5 with reserved characters:
git -C /path/to/RSSHub apply /path/to/moli-bridge/tools/rsshub/socks5-undici-auth.patch
```

To probe the underlying Moli behavior independently of RSSHub, after installing
the bridge dependencies run:

```sh
MOLI_TEST_BINARY=/absolute/path/to/moli node tools/rsshub/check-dynamic-table-layout.mjs
```

It compares a static row, a row and a block inserted after a button click, and
an existing block whose width changes. Moli 1.1.26 returned a nonzero static
rectangle, zero-sized inserted elements and the old width for the changed
block. Add `--expect-fixed` when checking a build expected to correct the issue;
that mode fails if any of the dynamic changes is missing from layout.
`--after-layout-metrics`, `--after-small-screenshot`, and
`--after-screenshot` compare the effects of those explicit CDP operations.
`--after-animation-frame` reports the geometry after two animation frames;
`--poll-visibility` checks whether Playwright's visible-element polling
converges without a manual capture.
For an optional local Chromium control, add `--chromium-reference` and set
`CHROMIUM_TEST_BINARY` to an absolute Chromium executable path.

To test it without changing the checkout, pass a checkout at the pinned commit:

```sh
./tools/rsshub/test-cdp-fetch-patch.sh /path/to/RSSHub
```

The test copies the two relevant source files to a temporary directory, applies
the patch, installs pinned Vitest, and runs RSSHub's retry test file with
isolated config, logger and browser mocks. Separately run
[`check-rsshub-cdp.mjs`](../flaresolverr-contract/README.md#rsshub-cdp-compatibility)
against Moli to exercise the real CDP Fetch replay. Neither check replaces
integration tests of the actual RSSHub installation or target sites.

## Real RSSHub modules with a local Moli gateway

With a pinned checkout, OpenSSL and a Moli executable, run:

```sh
MOLI_TEST_BINARY=/absolute/path/to/moli ./tools/rsshub/test-real-cdp-retry.sh /path/to/RSSHub
```

The script copies the pinned RSSHub source from Git, applies the retry and UPS patches in a temporary directory, and installs Vitest 5.1.0, Patchright 1.64.3, Cheerio 1.2.0 and Day.js 1.11.23. It executes RSSHub's actual `getPlaywrightPage`, patched `fetchWithPlaywrightRetry` and patched UPS route through the actual Moli CDP gateway. A generated TLS certificate and an allowlisted loopback proxy route the test Bilibili, Pixiv and UPS hostnames to local fixtures; the proxy gate prevents the browser from contacting real services. Configuration, logging and the first failed HTTP response are fixtures. The test checks page setup and navigation guards, Bilibili GET replay, a consumed Pixiv form, redirect isolation, abort cleanup, and UPS page interaction and parsing after hidden and visible loading placeholders. It does not run a complete RSSHub server or establish success against live sites.

To test the optional authenticated-proxy patch against the local proxy, add
`MOLI_TEST_AUTH_PROXY_PATCH=1 MOLI_TEST_AUTH_PROXY=1`. Add
`MOLI_TEST_DIRECT_CDP=1` to use a direct WebSocket instead of HTTP discovery.
Set `MOLI_TEST_PROXY_KIND=https` or `MOLI_TEST_PROXY_KIND=socks5` to test those
proxy protocols (the default is HTTP). For SOCKS5, add
`MOLI_TEST_SOCKS5H_ALIAS=1` to test normalization of the RSSHub configuration.
For the negative authentication check also set `MOLI_TEST_WRONG_PROXY_AUTH=1`
and append `-t 'does not bypass an authenticated proxy'` to the command. The
fixtures verify proxy authentication, failure without direct fallback, selected
error redaction, and rejection of unsupported authenticated proxy protocols.
Set `MOLI_TEST_PERCENT_PROXY_PASSWORD=1` to exercise a password containing a
literal percent escape as well as other reserved characters.
For HTTPS, set `MOLI_TEST_UNTRUSTED_PROXY=1` and append
`-t 'rejects an untrusted HTTPS proxy'` to test certificate rejection. To probe
the gateway without the RSSHub patch, set `MOLI_TEST_GATEWAY_PROXY_PROBE=1` and
append `-t 'gateway probe'`.

For an offline run, set `MOLI_RSSHUB_NODE_MODULES` to a directory containing the specified Vitest, Cheerio and Day.js versions, and `RSSHUB_PATCHRIGHT_PATH` to Patchright 1.64.3's `index.mjs`; all four versions are checked before execution. The checkout must already contain the needed Git objects. Temporary files and processes are removed when the test exits.

Set `MOLI_TEST_UNPATCHED_UPS=1` to test the original UPS route against a Moli
build that is expected to fix dynamic layout; the CDP retry patch is still
applied for the other checks. With Moli 1.1.26 the unpatched UPS route times
out on the fixture, so this option is a regression probe rather than a passing
baseline.

## Complete RSSHub server with local fixtures

The pinned RSSHub source can also be tested as a complete built server. Apply
the patches needed for the scenarios below, install its lockfile dependencies and build
it according to RSSHub's build instructions. With that source tree, a Node.js
24.15+ or 26.13+ executable, OpenSSL, Docker and a local bridge image, run:

```sh
./tools/rsshub/check-full-rsshub.sh /path/to/built/RSSHub /path/to/node24 moli-bridge:local
```

The script starts the actual RSSHub server, Moli CDP gateway, an authenticated
proxy and a generated TLS fixture in one temporary container with external
networking disabled. The proxy accepts only `www.ups.com:443` and
`api.bilibili.com:443` and maps them to the local fixture; a Moli wrapper
refuses to start without that proxy. The test
calls the real `/ups/track/...` RSS route and checks two dynamic rows after
hidden and visible loading states, image blocking, credentials containing
reserved characters and a literal percent escape, and an HTTP error for wrong
proxy credentials without reaching the fixture. That error response is checked
for the fixture username; other components and logs are not guaranteed to redact
credentials. The wrapper supplies the local test CA to Moli. The container and
generated credentials are removed on exit. This does not verify an installed
RSSHub instance or the live UPS site.

With the Node retry patch applied, add `MOLI_TEST_BILIBILI_RETRY=1` to call the
real `/bilibili/popular/all` route. Its local fixture first returns HTTP 412 and
then a JSON item; the test checks that the browser replays the request and the
item appears in the RSS feed. To confirm the unpatched baseline, omit the Node
patch and set `MOLI_TEST_EXPECT_NODE_RETRY=0` as well. These checks use local
fixtures and do not establish that a live Bilibili challenge can be solved.
With `MOLI_TEST_PROXY_KIND=socks5`, this also checks the native fetch's encoded
SOCKS5 credentials and verifies that wrong credentials do not reach the fixture.
Apply `socks5-undici-auth.patch` for this scenario.

The default fixture uses HTTP CONNECT. Set `MOLI_TEST_PROXY_KIND=https` or
`MOLI_TEST_PROXY_KIND=socks5` to exercise authenticated HTTPS or SOCKS5; the
SOCKS fixture requires a domain-name CONNECT. With SOCKS5, additionally set
`MOLI_TEST_SOCKS5H_ALIAS=1` to test RSSHub's `socks5h` configuration. Set
`MOLI_TEST_DIRECT_CDP=1` for direct WebSocket CDP instead of HTTP discovery.
With HTTPS, `MOLI_TEST_UNTRUSTED_PROXY=1` runs the negative certificate check
instead of the success and wrong-password checks. The fixture explicitly gives
Moli its test CA; production HTTPS proxies still require Moli to trust their CA.

The development check used commit `8f71938d4b9b032cab5712788d5ca8f4f327917c`,
Node 24.22.1, pnpm 12.21.0 and the pinned Moli 1.1.26 binary. Dependencies were
installed from the frozen lockfile with lifecycle scripts disabled, and the
full route registry and server were built in a container without external
network access.
