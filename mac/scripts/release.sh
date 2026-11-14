#!/bin/sh
# Builds Peryda for Mac for download from the website: a Release build signed with Developer ID and
# the hardened runtime. The app itself is notarized and stapled first (so it opens offline once copied
# to Applications), then packed in a DMG that is signed, notarized and stapled too.
#
#   mac/scripts/release.sh            full release (needs a Developer ID Application certificate in
#                                     the keychain and a notarytool profile, see docs/BUILDING.md)
#   mac/scripts/release.sh --local    same build signed for this Mac only, no notarization (to try
#                                     the DMG locally; named …-LOCAL-UNSIGNED.dmg, never to be uploaded)
#   mac/scripts/release.sh --sign-only  signed with Developer ID exactly like a release, but nothing is
#                                     sent to Apple (checks the signing before a real run; named
#                                     …-NOT-NOTARIZED.dmg, never to be uploaded)
#   mac/scripts/release.sh --resume   carries on a release that stopped while waiting for Apple (the Mac
#                                     slept, the connection dropped): the same app, the same submissions
#
# A release keeps its work in build/release-<version>/ until it is done, with Apple's submission ids,
# so what was sent to Apple is always what gets stapled. Waiting rides out a lost connection or a
# locked keychain: Apple is asked again every minute.
#
# Settings (environment): NOTARY_PROFILE (default "peryda-notary"), TEAM_ID (default: read from the
# Developer ID certificate's name, "Developer ID Application: Name (TEAMID)").
# Update rehearsal only (scripts/update-rehearsal.sh; never with a release): PERYDA_VERSION and
# PERYDA_BUILD build another version number, PERYDA_UPDATE_FEED_URL points the app at a test feed.
# The disk image is then named …-REHEARSAL.dmg.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
mode=${1:-release}
profile=${NOTARY_PROFILE:-peryda-notary}
github_feed=$(sed -n 's/^ *PERYDA_UPDATE_FEED_URL: *\(https:[^ ]*\) *$/\1/p' "$here/project.yml" | head -1)
version=${PERYDA_VERSION:-$(grep 'MARKETING_VERSION' "$here/project.yml" | head -1 | sed 's/.*: *//; s/"//g')}
rehearsal=""
if [ -n "${PERYDA_VERSION:-}${PERYDA_BUILD:-}${PERYDA_UPDATE_FEED_URL:-}" ]; then rehearsal=1; fi
out="$here/build"
mkdir -p "$out"

fail() {
  echo "$1" >&2
  exit 1
}

case "$mode" in release | --resume | --local | --sign-only) ;; *) fail "Unknown option: $mode" ;; esac
[ -n "$github_feed" ] || fail "No PERYDA_UPDATE_FEED_URL in project.yml."
if [ -n "$rehearsal" ] && { [ "$mode" = "release" ] || [ "$mode" = "--resume" ]; }; then
  fail "PERYDA_VERSION, PERYDA_BUILD and PERYDA_UPDATE_FEED_URL are for the update rehearsal only (--sign-only or --local)."
fi

# Work outside Documents (iCloud's extended attributes break code signing there). Local and sign-only
# builds use a fresh temporary folder; a release keeps its own until it is done (see above).
notarizing=""
case "$mode" in
  release | --resume)
    notarizing=1
    work="$out/release-$version"
    if [ "$mode" = "release" ]; then
      if [ -s "$work/app.id" ] && [ ! -f "$work/done" ]; then
        fail "Peryda $version is still waiting for Apple (submission $(cat "$work/app.id")). Run release.sh --resume, or delete $work to start over."
      fi
      rm -rf "$work"
      mkdir -p "$work"
    fi
    ;;
  *)
    work=$(mktemp -d "${TMPDIR:-/tmp}/peryda-mac-release.XXXXXX")
    trap 'rm -rf "$work"' EXIT
    ;;
esac

# Sends a file to Apple once (its submission id is kept in the second argument) and waits for the
# verdict. A lost connection, a sleeping Mac or a locked keychain only delays the answer: Apple is asked
# again every minute. A refusal prints Apple's log.
notarize() {
  file=$1
  idfile=$2
  if [ ! -s "$idfile" ]; then
    submitted=$(xcrun notarytool submit "$file" --keychain-profile "$profile" --output-format json)
    echo "$submitted" | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' > "$idfile"
    [ -s "$idfile" ] || fail "Apple gave no submission id: $submitted"
  fi
  id=$(cat "$idfile")
  echo "  submission $id"
  asked=0
  while :; do
    status=$(xcrun notarytool info "$id" --keychain-profile "$profile" --output-format json 2>/dev/null | sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' || true)
    case "$status" in
      Accepted) echo "  accepted"; return 0 ;;
      Invalid | Rejected)
        xcrun notarytool log "$id" --keychain-profile "$profile" >&2 || true
        fail "Apple did not accept $(basename "$file") ($status)."
        ;;
    esac
    asked=$((asked + 1))
    [ $((asked % 15)) -ne 1 ] || echo "  $(date '+%H:%M') still waiting (${status:-no answer})"
    sleep 60
  done
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

# Every downloadable build can update itself, so it must carry the public half of the update key.
update_key=$(sed -n 's/^ *PERYDA_UPDATE_PUBLIC_KEY: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$here/project.yml" | head -1)
if [ "$mode" != "--local" ] && [ -z "$update_key" ]; then
  fail "No update key in project.yml (PERYDA_UPDATE_PUBLIC_KEY). Run scripts/update-keys.sh first."
fi

rehearsal_settings=""
if [ -n "$rehearsal" ]; then
  rehearsal_settings="MARKETING_VERSION=$version"
  [ -z "${PERYDA_BUILD:-}" ] || rehearsal_settings="$rehearsal_settings CURRENT_PROJECT_VERSION=$PERYDA_BUILD"
  [ -z "${PERYDA_UPDATE_FEED_URL:-}" ] || rehearsal_settings="$rehearsal_settings PERYDA_UPDATE_FEED_URL=$PERYDA_UPDATE_FEED_URL"
fi

cd "$here"
app_in() { echo "$1/Peryda.xcarchive/Products/Applications/Peryda.app"; }
if [ "$mode" = "--resume" ]; then
  app=$(app_in "$work")
  [ -d "$app" ] || fail "Nothing to resume in $work: run release.sh first."
  echo "› Resuming Peryda $version from $work"
else
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
    CODE_SIGN_IDENTITY="$identity" ENABLE_HARDENED_RUNTIME=YES $extra $rehearsal_settings \
    archive -quiet

  app="$work/Peryda.xcarchive/Products/Applications/Peryda.app"
  xattr -cr "$app"

  # Sparkle's helpers arrive signed by the Sparkle project for development only. They are signed again with
  # this identity and the hardened runtime, inside out and without --deep (Sparkle's documented order),
  # then the app itself with the entitlements it was built with.
  if [ "$mode" = "--local" ]; then sign_id="-"; stamp="--timestamp=none"; else sign_id="$dmg_identity"; stamp="--timestamp"; fi
  sparkle="$app/Contents/Frameworks/Sparkle.framework"
  [ -d "$sparkle/Versions/B" ] || fail "Sparkle.framework is missing from the app."
  codesign -d --entitlements - --xml "$app" > "$work/entitlements.plist" 2>/dev/null
  codesign -f -s "$sign_id" -o runtime "$stamp" "$sparkle/Versions/B/XPCServices/Installer.xpc"
  codesign -f -s "$sign_id" -o runtime "$stamp" --preserve-metadata=entitlements "$sparkle/Versions/B/XPCServices/Downloader.xpc"
  codesign -f -s "$sign_id" -o runtime "$stamp" "$sparkle/Versions/B/Autoupdate"
  codesign -f -s "$sign_id" -o runtime "$stamp" "$sparkle/Versions/B/Updater.app"
  codesign -f -s "$sign_id" -o runtime "$stamp" "$sparkle"
  codesign -f -s "$sign_id" -o runtime "$stamp" --entitlements "$work/entitlements.plist" "$app"
  codesign --verify --deep --strict "$app"
  for part in "$sparkle/Versions/B/XPCServices/Installer.xpc" "$sparkle/Versions/B/XPCServices/Downloader.xpc" \
    "$sparkle/Versions/B/Autoupdate" "$sparkle/Versions/B/Updater.app" "$sparkle"; do
    info=$(codesign -dv --verbose=4 "$part" 2>&1)
    echo "$info" | grep -q '^CodeDirectory .*flags=.*runtime' || fail "$(basename "$part") is not signed with the hardened runtime."
    if [ -n "$team" ]; then
      echo "$info" | grep -qx "TeamIdentifier=$team" || fail "$(basename "$part") is not signed by team $team."
    fi
  done
  if [ "$mode" != "--local" ]; then
    [ -n "$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$app/Contents/Info.plist" 2>/dev/null)" ] || fail "The app has no update key."
  fi
  # A release reads updates from the GitHub release feed and from nowhere else.
  feed=$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$app/Contents/Info.plist" 2>/dev/null || true)
  if [ -z "$rehearsal" ] && [ "$feed" != "$github_feed" ]; then fail "The app's update feed is $feed, not $github_feed."; fi
  # What is shipped must be what was meant: the hardened runtime, the right team, no debugging entitlement.
  signature=$(codesign -dv --verbose=4 "$app" 2>&1)
  echo "$signature" | grep -q '^CodeDirectory .*flags=.*runtime' || fail "The app is not signed with the hardened runtime."
  if [ -n "$team" ]; then
    echo "$signature" | grep -qx "TeamIdentifier=$team" || fail "The app is not signed by team $team."
  fi
  if codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q 'get-task-allow'; then
    fail "The app carries the get-task-allow (debugging) entitlement."
  fi
  echo "› Signature verified: hardened runtime (app and Sparkle's helpers), team ${team:-none (local)}, no get-task-allow"
fi

if [ -n "$notarizing" ]; then
  echo "› Notarizing the app (Apple usually answers in minutes; a first submission can take hours)"
  [ -s "$work/app.id" ] || ditto -c -k --keepParent "$app" "$work/Peryda.zip"
  notarize "$work/Peryda.zip" "$work/app.id"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  spctl --assess --type exec -vvv "$app"
fi

if [ -n "$rehearsal" ]; then
  dmg="$out/Peryda-$version-REHEARSAL.dmg"
elif [ "$mode" = "--local" ]; then
  dmg="$out/Peryda-$version-LOCAL-UNSIGNED.dmg"
elif [ "$mode" = "--sign-only" ]; then
  dmg="$out/Peryda-$version-NOT-NOTARIZED.dmg"
else
  dmg="$out/Peryda-$version.dmg"
fi
# A disk image already sent to Apple is kept as it is (resuming); otherwise it is made afresh.
if [ -s "$work/dmg.id" ] && [ -f "$dmg" ]; then
  echo "› Disk image already sent to Apple: $dmg"
else
  echo "› Making the disk image"
  rm -rf "$work/dmg" "$work/dmg.id"
  mkdir -p "$work/dmg"
  ditto "$app" "$work/dmg/Peryda.app"
  ln -s /Applications "$work/dmg/Applications"
  rm -f "$dmg"
  hdiutil create -quiet -volname "Peryda" -srcfolder "$work/dmg" -fs HFS+ -format UDZO "$dmg"
fi

if [ "$mode" = "--local" ]; then
  echo "› Local build (not notarized, not for upload): $dmg"
  exit 0
fi

[ -s "$work/dmg.id" ] || codesign --sign "$dmg_identity" --timestamp "$dmg"
codesign -dv "$dmg" 2>&1 | grep -qx "TeamIdentifier=$team" || fail "The disk image is not signed by team $team."
if [ "$mode" = "--sign-only" ]; then
  echo "› Signed with Developer ID, not sent to Apple (not for upload): $dmg"
  exit 0
fi
echo "› Notarizing the disk image"
notarize "$dmg" "$work/dmg.id"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature -v "$dmg"
touch "$work/done"
echo "› Ready: $dmg"
echo "  Next: mac/scripts/appcast.sh \"$dmg\" writes the update feed for this version."
