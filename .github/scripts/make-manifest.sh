#!/usr/bin/env bash
# Usage: make-manifest.sh X.Y.Z
# Run in the directory holding tobor, tobor-arm64 and tobor.apk; writes
# SHA256SUMS and manifest.json next to them.
set -euo pipefail

version=$1
sha256sum tobor tobor-arm64 tobor.apk > SHA256SUMS

sum() { sha256sum "$1" | cut -d' ' -f1; }

jq -cn \
  --arg version "$version" \
  --arg x64 "$(sum tobor)" \
  --arg arm64 "$(sum tobor-arm64)" \
  --arg apk "$(sum tobor.apk)" \
  '{version: $version, assets: [
    {name: "tobor",       target: "linux-x64",   sha256: $x64},
    {name: "tobor-arm64", target: "linux-arm64", sha256: $arm64},
    {name: "tobor.apk",   target: "android",     sha256: $apk}
  ]}' > manifest.json
