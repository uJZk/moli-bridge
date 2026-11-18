#!/bin/sh
# Prepare independently verified, architecture-neutral JS dependencies and Moli artifacts.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/moli-image-assets.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/npm"
cp "$root/flaresolverr-bridge/package.json" "$root/flaresolverr-bridge/package-lock.json" "$stage/npm/"
npm ci --prefix "$stage/npm" --omit=dev --ignore-scripts
for arch in amd64 arm64; do
  case "$arch" in
    amd64) target=x86_64; checksum=b57b1b7aa97548669234908f094a44c93e39d91b4c4246c55720c2eff3f93bb5 ;;
    arm64) target=aarch64; checksum=de00b0e66b35decbc7b7a04d213a9798535db8127070dfcde62355b7cb6955a5 ;;
  esac
  archive="$stage/moli-$arch.tar.gz"
  if [ -n "${MOLI_RELEASE_CACHE_DIR:-}" ] && [ -f "$MOLI_RELEASE_CACHE_DIR/moli-1.1.26-$arch.tar.gz" ]; then
    cp "$MOLI_RELEASE_CACHE_DIR/moli-1.1.26-$arch.tar.gz" "$archive"
  else
    curl -fsSL "https://github.com/lexmount/moli/releases/download/v1.1.26/moli-$target-unknown-linux-gnu.tar.gz" -o "$archive"
  fi
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
done
rm -rf "$root/.container-assets"
mv "$stage" "$root/.container-assets"
trap - EXIT HUP INT TERM
