#!/bin/sh
# Writes the Mac update feed (mac/build/appcast.xml) for a notarized Peryda DMG made by release.sh.
# The DMG is signed with the update key in this Mac's keychain (scripts/update-keys.sh); the macOS
# keychain may ask once to let sign_update use it. Upload the DMG and appcast.xml to the GitHub
# release v<version>: the apps read the feed from the latest release.
#
#   mac/scripts/appcast.sh mac/build/Peryda-0.1.1.dmg [notes.html]
#
# notes.html (optional): a few lines of plain HTML shown in the update window ("What's new").
# Do not edit appcast.xml afterwards: it is signed, and the apps reject a changed feed.
# Update rehearsal only (scripts/update-rehearsal.sh): PERYDA_DOWNLOAD_BASE=http://127.0.0.1:<port>
# offers the disk image from there instead, and the feed goes to build/rehearsal/appcast.xml; the
# rehearsal signs with its own throw-away key (PERYDA_SPARKLE_ACCOUNT), never the release key.
#
# For a release the DMG must be notarized and stapled (app and disk image), the app inside must read the
# GitHub feed in project.yml and must not be a rehearsal build, and its build number must be higher than
# the one in the latest published feed (audit MA-5, 15 Nov).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dmg=${1:?usage: appcast.sh <Peryda-x.y.z.dmg> [notes.html]}
notes=${2:-}
repo=${PERYDA_REPO:-isnalcan/peryda-open}
base=${PERYDA_DOWNLOAD_BASE:-}
out="$here/build/appcast.xml"
account=${PERYDA_SPARKLE_ACCOUNT:-}
if [ -n "$base" ]; then
  case "$base" in http://127.0.0.1:*) ;; *) echo "PERYDA_DOWNLOAD_BASE is for the update rehearsal on this Mac (http://127.0.0.1:<port>)." >&2; exit 1 ;; esac
  [ -n "$account" ] || { echo "The rehearsal signs with its own key: set PERYDA_SPARKLE_ACCOUNT (scripts/update-rehearsal.sh does)." >&2; exit 1; }
  out="$here/build/rehearsal/appcast.xml"
elif [ -n "$account" ]; then
  echo "PERYDA_SPARKLE_ACCOUNT is for the update rehearsal only; a release is signed with the release key." >&2
  exit 1
fi

fail() {
  echo "$1" >&2
  exit 1
}

case "$dmg" in *LOCAL-UNSIGNED* | *NOT-NOTARIZED* | *REHEARSAL*) [ -n "$base" ] || fail "This is not a release DMG; only a notarized release DMG can be offered as an update." ;; esac
bin=$("$here/scripts/sparkle-bin.sh")
# Sparkle's tools sign with the release key, or with the rehearsal's own key.
acct=""
[ -z "$account" ] || acct="--account $account"

# What the update is, read from the app inside the disk image itself.
mnt=$(mktemp -d "${TMPDIR:-/tmp}/peryda-appcast.XXXXXX")
trap 'hdiutil detach "$mnt" -quiet 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true' EXIT
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" -quiet "$dmg"
plist="$mnt/Peryda.app/Contents/Info.plist"
short=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")
minos=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$plist")
key=$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$plist" 2>/dev/null || true)
feed=$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$plist" 2>/dev/null || true)
is_rehearsal=$(/usr/libexec/PlistBuddy -c 'Print :PerydaUpdateRehearsal' "$plist" 2>/dev/null || true)
if [ -z "$base" ]; then
  # A release: notarized and stapled, inside and out, reading the GitHub feed, not a rehearsal build.
  xcrun stapler validate -q "$dmg" || fail "The disk image is not stapled with Apple's notarization."
  spctl -a -t open --context context:primary-signature "$dmg" 2>/dev/null || fail "Gatekeeper refuses the disk image."
  xcrun stapler validate -q "$mnt/Peryda.app" || fail "The app inside is not stapled with Apple's notarization."
  spctl -a -t exec "$mnt/Peryda.app" 2>/dev/null || fail "Gatekeeper refuses the app inside."
  github_feed=$(sed -n 's/^ *PERYDA_UPDATE_FEED_URL: *\(https:[^ ]*\) *$/\1/p' "$here/project.yml" | head -1)
  [ -n "$github_feed" ] && [ "$feed" = "$github_feed" ] || fail "The app inside reads $feed, not the release feed $github_feed."
  [ "$is_rehearsal" != "YES" ] || fail "The app inside is an update-rehearsal build."
fi
hdiutil detach "$mnt" -quiet

[ "$(basename "$dmg")" = "Peryda-$short.dmg" ] || fail "The file should be named Peryda-$short.dmg."
case "$build" in '' | *[!0-9]*) fail "The build number ($build) is not a whole number." ;; esac
if [ -z "$base" ]; then
  # Sparkle compares build numbers: the new one must be higher than the one readers have now.
  previous=$(mktemp "${TMPDIR:-/tmp}/peryda-previous-feed.XXXXXX")
  code=$(curl -sL -o "$previous" -w '%{http_code}' "https://github.com/$repo/releases/latest/download/appcast.xml" || echo 000)
  case "$code" in
    200)
      last=$(sed -n 's/.*<sparkle:version>\([0-9][0-9]*\)<\/sparkle:version>.*/\1/p' "$previous" | sort -n | tail -1)
      rm -f "$previous"
      [ -z "$last" ] || [ "$build" -gt "$last" ] || fail "Build $build is not higher than the published build $last: raise CURRENT_PROJECT_VERSION."
      ;;
    404) rm -f "$previous" ;; # No release with a feed yet: this is the first.
    *) rm -f "$previous"; fail "Could not read the published feed (HTTP $code) to compare build numbers." ;;
  esac
fi
# shellcheck disable=SC2086
mine=$("$bin/generate_keys" $acct -p 2>/dev/null) || fail "No update key in this Mac's keychain. Run scripts/update-keys.sh."
[ "$key" = "$mine" ] || fail "The app inside was built with a different update key than the one in this keychain."

# sparkle:edSignature="…" length="…", then checked once more against the file.
# shellcheck disable=SC2086
enclosure=$("$bin/sign_update" $acct "$dmg")
signature=$(echo "$enclosure" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')
[ -n "$signature" ] || fail "sign_update gave no signature."
# shellcheck disable=SC2086
"$bin/sign_update" $acct --verify "$dmg" "$signature" >/dev/null || fail "The signature does not verify."

url="https://github.com/$repo/releases/download/v$short/Peryda-$short.dmg"
[ -z "$base" ] || url="$base/Peryda-$short.dmg"

description=""
if [ -n "$notes" ]; then
  description="      <description><![CDATA[$(cat "$notes")]]></description>"
fi

mkdir -p "$(dirname "$out")"
cat > "$out" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Peryda</title>
    <item>
      <title>Peryda $short</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <sparkle:version>$build</sparkle:version>
      <sparkle:shortVersionString>$short</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$minos</sparkle:minimumSystemVersion>
$description
      <enclosure url="$url" type="application/octet-stream" $enclosure/>
    </item>
  </channel>
</rss>
XML
xmllint --noout "$out"
# The apps accept only a signed feed (SURequireSignedFeed): the signature goes inside the file.
# shellcheck disable=SC2086
"$bin/sign_update" $acct "$out" >/dev/null
# shellcheck disable=SC2086
"$bin/sign_update" $acct --verify "$out" >/dev/null || fail "The feed's signature does not verify."
xmllint --noout "$out"
echo "› $out: Peryda $short (build $build); update and feed signatures verified"
