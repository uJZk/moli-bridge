#!/bin/sh
# Verify the registry's image index contains the expected source revision.
set -eu
if [ "$#" -ne 2 ]; then
  echo "Usage: $0 IMAGE EXPECTED_REVISION" >&2
  exit 2
fi
image=$1
revision=$2
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT HUP INT TERM

for attempt in 1 2 3 4 5 6; do
  if docker buildx imagetools inspect "$image" --format '{{json .Image}}' > "$metadata" &&
    node - "$metadata" "$revision" <<'NODE'
const fs = require('node:fs');
const images = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const revision = process.argv[3];
for (const arch of ['amd64', 'arm64']) {
  const entry = Object.entries(images ?? {}).find(([platform]) =>
    platform === `linux/${arch}` || platform.startsWith(`linux/${arch}/`));
  const actual = entry?.[1]?.config?.Labels?.['org.opencontainers.image.revision'];
  if (actual !== revision) {
    console.error(`linux/${arch}: expected revision ${revision}, got ${actual ?? 'missing'}`);
    process.exitCode = 1;
  } else {
    console.log(`${entry[0]}: ${actual}`);
  }
}
NODE
  then
    exit 0
  fi
  if [ "$attempt" -lt 6 ]; then
    sleep 5
  fi
done
echo "Failed to verify both image platforms after publication: $image" >&2
exit 1
