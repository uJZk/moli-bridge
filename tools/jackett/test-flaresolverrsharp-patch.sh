#!/bin/sh
# Test the optional patch in a temporary source tree against a disposable bridge.
set -eu
if [ "$#" -ne 2 ]; then
  printf 'Usage: %s /path/to/FlareSolverrSharp http://127.0.0.1:8191/\n' "$0" >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
upstream=$(CDPATH= cd -- "$1" && pwd)
bridge=$2
revision=86027526c27cc32ff4f035535e16dd7c85763dea
if [ "$(git -C "$upstream" rev-parse HEAD)" != "$revision" ]; then
  printf 'Expected FlareSolverrSharp commit %s\n' "$revision" >&2
  exit 1
fi
stage=$(mktemp -d "${TMPDIR:-/tmp}/moli-sharp-patch.XXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
NUGET_PACKAGES="$stage/packages"
export NUGET_PACKAGES
git -C "$upstream" archive "$revision" src/FlareSolverrSharp LICENSE | tar -x -C "$stage"
git -C "$stage" apply --check "$root/tools/jackett/flaresolverrsharp-datadome.patch"
git -C "$stage" apply "$root/tools/jackett/flaresolverrsharp-datadome.patch"
DOTNET_TEST_BIN=${DOTNET_TEST_BIN:-dotnet}
export DOTNET_TEST_BIN
if [ -n "${MOLI_NUGET_CONFIG:-}" ]; then
  "$DOTNET_TEST_BIN" restore "$stage/src/FlareSolverrSharp/FlareSolverrSharp.csproj" --configfile "$MOLI_NUGET_CONFIG"
else
  "$DOTNET_TEST_BIN" restore "$stage/src/FlareSolverrSharp/FlareSolverrSharp.csproj"
fi
"$DOTNET_TEST_BIN" pack "$stage/src/FlareSolverrSharp/FlareSolverrSharp.csproj" --no-restore \
  --configuration Release -p:PackageVersion=4.0.0-moli.1 --output "$stage/feed"
python3 - "$stage/feed/FlareSolverrSharp.4.0.0-moli.1.nupkg" "$stage/LICENSE" <<'PY'
from pathlib import Path
import sys
import zipfile
from xml.etree import ElementTree

with zipfile.ZipFile(sys.argv[1]) as package:
    if package.read('LICENSE') != Path(sys.argv[2]).read_bytes():
        raise SystemExit('Packaged MIT license does not match upstream')
    metadata = ElementTree.fromstring(package.read('FlareSolverrSharp.nuspec'))
    license_node = next((node for node in metadata.iter() if node.tag.endswith('}license')), None)
    if license_node is None or license_node.get('type') != 'expression' or license_node.text != 'MIT':
        raise SystemExit('Package does not declare the MIT license')
PY
mkdir "$stage/runner"
cp "$root/tools/flaresolverr-contract/jackett-sharp/Program.cs" "$stage/runner/Program.cs"
cat > "$stage/runner/Contract.csproj" <<'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
  <ItemGroup><PackageReference Include="FlareSolverrSharp" Version="4.0.0-moli.1" /></ItemGroup>
</Project>
EOF
"$DOTNET_TEST_BIN" restore "$stage/runner/Contract.csproj" --source "$stage/feed"
cat > "$stage/dotnet-wrapper" <<'EOF'
#!/bin/sh
if [ "$1" = run ]; then shift; exec "$DOTNET_TEST_BIN" run --no-restore "$@"; fi
exec "$DOTNET_TEST_BIN" "$@"
EOF
chmod 700 "$stage/dotnet-wrapper"
python3 "$root/tools/flaresolverr-contract/check-jackett-sharp.py" --bridge "$bridge" \
  --dotnet "$stage/dotnet-wrapper" --patched-project "$stage/runner/Contract.csproj"
