#!/bin/sh
# Build pinned Jackett against the locally patched FlareSolverrSharp package.
set -eu
if [ "$#" -ne 2 ]; then
  printf 'Usage: %s /path/to/Jackett /path/to/FlareSolverrSharp\n' "$0" >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
jackett=$(CDPATH= cd -- "$1" && pwd)
sharp=$(CDPATH= cd -- "$2" && pwd)
jackett_revision=ffe6cd64391787612967a2cd28850970720d9fe3
sharp_revision=86027526c27cc32ff4f035535e16dd7c85763dea
if [ "$(git -C "$jackett" rev-parse HEAD)" != "$jackett_revision" ] || \
   [ "$(git -C "$sharp" rev-parse HEAD)" != "$sharp_revision" ]; then
  printf 'The Jackett or FlareSolverrSharp checkout is not at its pinned commit.\n' >&2
  exit 1
fi
stage=$(mktemp -d "${TMPDIR:-/tmp}/moli-jackett-build.XXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir "$stage/jackett" "$stage/sharp"
git -C "$jackett" archive "$jackett_revision" | tar -x -C "$stage/jackett"
git -C "$sharp" archive "$sharp_revision" src/FlareSolverrSharp LICENSE | tar -x -C "$stage/sharp"
git -C "$stage/jackett" apply --check "$root/tools/jackett/jackett-datadome-package.patch"
git -C "$stage/jackett" apply "$root/tools/jackett/jackett-datadome-package.patch"
git -C "$stage/sharp" apply --check "$root/tools/jackett/flaresolverrsharp-datadome.patch"
git -C "$stage/sharp" apply "$root/tools/jackett/flaresolverrsharp-datadome.patch"
DOTNET_TEST_BIN=${DOTNET_TEST_BIN:-dotnet}
MOLI_NUGET_SOURCE=${MOLI_NUGET_SOURCE:-https://api.nuget.org/v3/index.json}
NUGET_PACKAGES="$stage/packages"
DOTNET_CLI_HOME="$stage/dotnet-home"
DOTNET_CLI_TELEMETRY_OPTOUT=1
DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export NUGET_PACKAGES DOTNET_CLI_HOME DOTNET_CLI_TELEMETRY_OPTOUT DOTNET_SKIP_FIRST_TIME_EXPERIENCE
"$DOTNET_TEST_BIN" restore "$stage/sharp/src/FlareSolverrSharp/FlareSolverrSharp.csproj" \
  --source "$MOLI_NUGET_SOURCE" -p:NuGetAudit=false
"$DOTNET_TEST_BIN" pack "$stage/sharp/src/FlareSolverrSharp/FlareSolverrSharp.csproj" --no-restore \
  --configuration Release -p:PackageVersion=4.0.0-moli.1 --output "$stage/feed"
"$DOTNET_TEST_BIN" restore "$stage/jackett/src/Jackett.Server/Jackett.Server.csproj" \
  --source "$stage/feed" --source "$MOLI_NUGET_SOURCE" -p:TargetFrameworks=net9.0 -p:NuGetAudit=false
"$DOTNET_TEST_BIN" build "$stage/jackett/src/Jackett.Server/Jackett.Server.csproj" \
  --configuration Release --framework net9.0 --no-restore -p:TargetFrameworks=net9.0
python3 - "$stage" <<'PY'
import base64
import hashlib
import json
from pathlib import Path
import sys

stage = Path(sys.argv[1])
package = stage / 'feed/FlareSolverrSharp.4.0.0-moli.1.nupkg'
expected = base64.b64encode(hashlib.sha512(package.read_bytes()).digest()).decode()
for relative in ('src/Jackett.Common/obj/project.assets.json', 'src/Jackett.Server/obj/project.assets.json'):
    data = json.loads((stage / 'jackett' / relative).read_text())
    entry = data['libraries'].get('FlareSolverrSharp/4.0.0-moli.1')
    if not entry or entry.get('sha512') != expected:
        raise SystemExit(f'Patched package identity or hash mismatch in {relative}')
deps = json.loads((stage / 'jackett/src/Jackett.Server/bin/Release/net9.0/jackett.deps.json').read_text())
if 'FlareSolverrSharp/4.0.0-moli.1' not in deps['libraries']:
    raise SystemExit('Built Jackett dependency manifest omits patched package')
print('PASS Jackett build uses the exact locally patched FlareSolverrSharp package')
PY
