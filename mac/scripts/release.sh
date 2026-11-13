#!/bin/sh
# Builds Peryda for Mac for download from the website: a Release build signed with Developer ID and
# the hardened runtime. The app itself is notarized and stapled first (so it opens offline once copied
# to Applications), then packed in a DMG that is signed, notarized and stapled too.
#
#   mac/scripts/release.sh            full release (needs a Developer ID Application certificate in
#                                     the keychain and a notarytool profile, see docs/BUILDING.md)
#   mac/scripts/release.sh --local    same build signed for this Mac only, no notarization (to try
#                                     the DMG locally; named …-LOCAL-UNSIGNED.dmg, never to be uploaded)
#
# Settings (environment): NOTARY_PROFILE (default "peryda-notary"), TEAM_ID (default: read from the
# Developer ID certificate's name, "Developer ID Application: Name (TEAMID)").
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
mode=${1:-release}
profile=${NOTARY_PROFILE:-peryda-notary}
version=$(grep 'MARKETING_VERSION' "$here/project.yml" | head -1 | sed 's/.*: *//; s/"//g')
out="$here/build"
# A fresh folder each time, outside Documents: iCloud's extended attributes break code signing there.
work=$(mktemp -d "${TMPDIR:-/tmp}/peryda-mac-release.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

fail() {
  echo "$1" >&2
  exit 1
}

team=""
if [ "$mode" = "--local" ]; then
  identity="-"
  extra="CODE_SIGN_STYLE=Manual"
else
  if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
    fail "No Developer ID Application certificate in the keychain. See docs/BUILDING.md."
  fi
  team=${TEAM_ID:-$(security find-identity -v -p codesigning | sed -n 's/.*"Developer ID Application: .*(\([A-Z0-9]\{10\}\))".*/\1/p' | head -1)}
  [ -n "$team" ] || fail "Could not read the team ID from the certificate; set TEAM_ID."
  # The certificate of that team (by its hash), so the DMG is signed by the same team as the app.
  dmg_identity=$(security find-identity -v -p codesigning | sed -n "s/^ *[0-9]*) \([0-9A-F]\{40\}\) \"Developer ID Application: .*($team)\"$/\1/p" | head -1)
  [ -n "$dmg_identity" ] || fail "No Developer ID Application certificate for team $team."
  identity="Developer ID Application"
  extra="CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=$team OTHER_CODE_SIGN_FLAGS=--timestamp"
fi

cd "$here"
# The project only uses the local PerydaKit package, so its pins are PerydaKit/Package.resolved.
[ -f PerydaKit/Package.resolved ] || fail "PerydaKit/Package.resolved is missing; package versions would not be pinned."
echo "› Building Peryda $version (Release) with XcodeGen $(xcodegen --version | sed 's/[^0-9.]//g')"
xcodegen generate --quiet
# Packages exactly as pinned: a tag moved upstream cannot change what is shipped.
# shellcheck disable=SC2086
xcodebuild -project PerydaMac.xcodeproj -scheme PerydaMac -configuration Release \
  -destination 'generic/platform=macOS' -archivePath "$work/Peryda.xcarchive" \
  -onlyUsePackageVersionsFromResolvedFile \
  CODE_SIGN_IDENTITY="$identity" ENABLE_HARDENED_RUNTIME=YES $extra \
  archive -quiet

app="$work/Peryda.xcarchive/Products/Applications/Peryda.app"
xattr -cr "$app"
codesign --verify --deep --strict "$app"
# What is shipped must be what was meant: the hardened runtime, the right team, no debugging entitlement.
signature=$(codesign -dv --verbose=4 "$app" 2>&1)
echo "$signature" | grep -q '^CodeDirectory .*flags=.*runtime' || fail "The app is not signed with the hardened runtime."
if [ -n "$team" ]; then
  echo "$signature" | grep -qx "TeamIdentifier=$team" || fail "The app is not signed by team $team."
fi
if codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q 'get-task-allow'; then
  fail "The app carries the get-task-allow (debugging) entitlement."
fi
echo "› Signature verified: hardened runtime, team ${team:-none (local)}, no get-task-allow"

if [ "$mode" != "--local" ]; then
  echo "› Sending the app to Apple for notarization (usually a few minutes)"
  ditto -c -k --keepParent "$app" "$work/Peryda.zip"
  xcrun notarytool submit "$work/Peryda.zip" --keychain-profile "$profile" --wait
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  spctl --assess --type exec -vvv "$app"
fi

echo "› Making the disk image"
mkdir -p "$work/dmg"
ditto "$app" "$work/dmg/Peryda.app"
ln -s /Applications "$work/dmg/Applications"
if [ "$mode" = "--local" ]; then
  dmg="$out/Peryda-$version-LOCAL-UNSIGNED.dmg"
else
  dmg="$out/Peryda-$version.dmg"
fi
rm -f "$dmg"
hdiutil create -quiet -volname "Peryda" -srcfolder "$work/dmg" -fs HFS+ -format UDZO "$dmg"

if [ "$mode" = "--local" ]; then
  echo "› Local build (not notarized, not for upload): $dmg"
  exit 0
fi

codesign --sign "$dmg_identity" --timestamp "$dmg"
codesign -dv "$dmg" 2>&1 | grep -qx "TeamIdentifier=$team" || fail "The disk image is not signed by team $team."
echo "› Sending the disk image to Apple for notarization"
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature -v "$dmg"
echo "› Ready: $dmg"
