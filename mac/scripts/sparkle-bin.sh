#!/bin/sh
# Prints the folder of Sparkle's command-line tools (generate_keys, sign_update), from the Sparkle
# package pinned in PerydaKit/Package.swift; fetches the packages first if needed.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin="$here/build/dd/SourcePackages/artifacts/sparkle/Sparkle/bin"
if [ ! -x "$bin/sign_update" ]; then
  xcodebuild -resolvePackageDependencies -project "$here/PerydaMac.xcodeproj" -scheme PerydaMacTests \
    -derivedDataPath "$here/build/dd" -onlyUsePackageVersionsFromResolvedFile >/dev/null
fi
[ -x "$bin/sign_update" ] || { echo "Sparkle's tools were not found in $bin" >&2; exit 1; }
echo "$bin"
