#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/artifacts/JellyfinQoL-1.0.0.0"
ZIP="$ROOT/artifacts/JellyfinQoL-1.0.0.0.zip"
rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"
dotnet publish "$ROOT/Jellyfin.Plugin.QoL/Jellyfin.Plugin.QoL.csproj" -c Release -o "$OUT"
(cd "$OUT" && zip -r "$ZIP" .)
echo "Release: $ZIP"
if command -v md5sum >/dev/null 2>&1; then
  echo "Manifest checksum (MD5): $(md5sum "$ZIP" | awk '{print $1}')"
fi
