#!/bin/sh
# Copies the shared design tokens, İlmek kinds and prompts into the Mac core's resources.
# A test (SharedResourcesTests) fails if the copies drift from shared/.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
for f in tokens.json yarn-kinds.json prompts.json ui-strings.json; do
  cp "$here/../shared/$f" "$here/PerydaKit/Sources/PerydaKit/Resources/shared/$f"
done
echo "shared resources synced"
