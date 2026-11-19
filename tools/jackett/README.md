# Optional FlareSolverrSharp DataDome patch

Jackett commit `ffe6cd64391787612967a2cd28850970720d9fe3` references
FlareSolverrSharp 4.0.0. Its handler does not send a DataDome-only response
to FlareSolverr and does not copy a returned `datadome` cookie into a retry.

`flaresolverrsharp-datadome.patch` targets FlareSolverrSharp source commit
`86027526c27cc32ff4f035535e16dd7c85763dea` (version 4.0.0). It treats the
block-specific `x-dd-b` response header as a challenge and includes the exact
`datadome` cookie name in the existing clearance-cookie handoff. It does not
detect arbitrary DataDome page formats or solve a CAPTCHA. The source and patch
are MIT licensed; the upstream copyright and license are retained in
[`FlareSolverrSharp-LICENSE`](FlareSolverrSharp-LICENSE). The patch also puts
the upstream license in the generated NuGet package and declares `MIT`.
The separate `jackett-datadome-package.patch` changes the package reference
in the pinned Jackett source to the separately versioned `4.0.0-moli.1` package.

With a checkout at that exact commit, .NET SDK 8, Python 3 and a disposable
bridge already running on loopback, run:

```sh
./tools/jackett/test-flaresolverrsharp-patch.sh /path/to/FlareSolverrSharp http://127.0.0.1:8191/
```

The test archives the pinned source into a temporary directory, applies the
patch, builds its original `netstandard2.0` project into a NuGet package with
the distinct version `4.0.0-moli.1`, verifies the packaged MIT license, and
runs the same handler fixture as the unmodified-package test. It checks
Cloudflare regression, error cases, the passive DataDome header, an unresolved
DataDome wall and a local Device Check through the bridge, including Cookie and
User-Agent handoff. Set `DOTNET_TEST_BIN` to a .NET executable if it is not on `PATH`.
For an offline restore, set `MOLI_NUGET_CONFIG` to a NuGet configuration with
a local feed containing `NETStandard.Library` 2.0.3,
`Microsoft.NETCore.Platforms` 1.1.0 and `Newtonsoft.Json` 13.0.4. The test
uses a temporary package cache and removes its files on exit.

To build a package for a compatible Jackett source tree, apply the patch to a
clean checkout at the pinned FlareSolverrSharp commit, then run:

```sh
git -C /path/to/FlareSolverrSharp apply --check /path/to/moli-bridge/tools/jackett/flaresolverrsharp-datadome.patch
git -C /path/to/FlareSolverrSharp apply /path/to/moli-bridge/tools/jackett/flaresolverrsharp-datadome.patch
dotnet pack /path/to/FlareSolverrSharp/src/FlareSolverrSharp/FlareSolverrSharp.csproj \
  --configuration Release -p:PackageVersion=4.0.0-moli.1 --output /path/to/local-nuget-feed
```

The Jackett source must reference `FlareSolverrSharp` version `4.0.0-moli.1`
and restore from that local feed as well as its normal dependency sources. The
provided Jackett patch makes that one-line change for the pinned Jackett commit;
apply it only to a clean compatible source checkout. Build and validate that
installation according to Jackett's own release process.

To repeat the complete `net9.0` Jackett build with both pinned checkouts, .NET
SDK 9, Git and Python 3:

```sh
./tools/jackett/test-full-jackett-build.sh /path/to/Jackett /path/to/FlareSolverrSharp
```

The script archives both pinned Git trees, applies the two patches in a
temporary directory, builds the package and Jackett, checks the exact package
hash in both restore manifests and checks the built runtime dependency manifest.
It uses a temporary package cache and disables NuGet audit for this repeatable
build check; perform the dependency and security checks required by the actual
release process separately. `DOTNET_TEST_BIN` selects the SDK executable, and
`MOLI_NUGET_SOURCE` can select an offline package feed or another NuGet source.
On the development host, SDK 9.0.321 built the pinned Jackett server without
build warnings or errors; the resulting app also started as an unprivileged
user and answered local HTTP in a temporary container without external network.

To exercise complete Torznab searches, build that pinned server with the
patched package, build a local Moli bridge image and run:

```sh
python3 tools/jackett/check-full-jackett.py \
  --jackett-dir /path/to/Jackett/src/Jackett.Server/bin/Release/net9.0 \
  --dotnet-root /path/to/dotnet9 --bridge-image moli-bridge:local
```

The test requires Docker and a locally available `rust:1.96.1-bookworm` image
(override with `--runner-image`). It starts Jackett, the bridge and a fixture
on loopback in a network namespace without external connectivity. It derives
two temporary definitions from the built TorrentKitty definition, changing
their identifiers and site links to the local fixture. It checks the Torznab
title and magnet hash, Cloudflare challenge navigation, DataDome Device Check recovery, and
Cookie and User-Agent handoff to Jackett's retry. Temporary containers and
test configuration are removed on exit. The supplied Jackett build must reference
the patched package and the SDK/runtime directory must be readable by the
unprivileged container user.

These local fixtures do not verify a real indexer or clearance against
DataDome or Cloudflare. Matching network egress and User-Agent requirements
still apply. The patches and tests do not change an installed Jackett service
or the bridge image.
