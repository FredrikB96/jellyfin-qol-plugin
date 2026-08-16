#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(sed -n 's:.*<Version>\([^<]*\)</Version>.*:\1:p' "$ROOT/Jellyfin.Plugin.QoL/Jellyfin.Plugin.QoL.csproj" | head -n1)}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must contain four numeric parts, for example 1.0.1.0." >&2
  exit 1
fi

OUT="$ROOT/artifacts/JellyfinQoL-$VERSION"
ZIP="$ROOT/artifacts/JellyfinQoL-$VERSION.zip"
rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"
dotnet publish "$ROOT/Jellyfin.Plugin.QoL/Jellyfin.Plugin.QoL.csproj" \
  -c Release \
  -o "$OUT" \
  -p:Version="$VERSION" \
  -p:FileVersion="$VERSION" \
  -p:AssemblyVersion="$VERSION"
(cd "$OUT" && zip -9 "$ZIP" Jellyfin.Plugin.QoL.dll)
echo "Release: $ZIP"
if command -v md5sum >/dev/null 2>&1; then
  echo "Manifest checksum (MD5): $(md5sum "$ZIP" | awk '{print $1}')"
fi
