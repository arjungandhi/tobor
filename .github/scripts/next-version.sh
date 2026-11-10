#!/usr/bin/env bash
# Print the next release version (X.Y.Z, no leading "v").
# Highest semver v* tag with patch+1; v0.1.0 when no vX.Y.Z tag exists.
# Tags that are not strictly vMAJOR.MINOR.PATCH are ignored.
set -euo pipefail

latest=$(git tag -l 'v*' | grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' | sort -V | tail -n1 || true)

if [ -z "$latest" ]; then
  echo "0.1.0"
  exit 0
fi

IFS=. read -r major minor patch <<<"${latest#v}"
echo "${major}.${minor}.$((patch + 1))"
