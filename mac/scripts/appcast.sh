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
# offers the disk image from there instead, and the feed goes to build/rehearsal/appcast.xml.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dmg=${1:?usage: appcast.sh <Peryda-x.y.z.dmg> [notes.html]}
notes=${2:-}
repo=${PERYDA_REPO:-isnalcan/peryda-open}
base=${PERYDA_DOWNLOAD_BASE:-}
out="$here/build/appcast.xml"
if [ -n "$base" ]; then
  case "$base" in http://127.0.0.1:*) ;; *) echo "PERYDA_DOWNLOAD_BASE is for the update rehearsal on this Mac (http://127.0.0.1:<port>)." >&2; exit 1 ;; esac
  out="$here/build/rehearsal/appcast.xml"
fi

fail() {
  echo "$1" >&2
  exit 1
}

case "$dmg" in *LOCAL-UNSIGNED*) fail "This is a local build; only a notarized release DMG can be offered as an update." ;; esac
bin=$("$here/scripts/sparkle-bin.sh")

# What the update is, read from the app inside the disk image itself.
mnt=$(mktemp -d "${TMPDIR:-/tmp}/peryda-appcast.XXXXXX")
trap 'hdiutil detach "$mnt" -quiet 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true' EXIT
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" -quiet "$dmg"
plist="$mnt/Peryda.app/Contents/Info.plist"
short=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")
minos=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$plist")
key=$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$plist" 2>/dev/null || true)
hdiutil detach "$mnt" -quiet

[ "$(basename "$dmg")" = "Peryda-$short.dmg" ] || fail "The file should be named Peryda-$short.dmg."
mine=$("$bin/generate_keys" -p 2>/dev/null) || fail "No update key in this Mac's keychain. Run scripts/update-keys.sh."
[ "$key" = "$mine" ] || fail "The app inside was built with a different update key than the one in this keychain."

# sparkle:edSignature="…" length="…", then checked once more against the file.
enclosure=$("$bin/sign_update" "$dmg")
signature=$(echo "$enclosure" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')
[ -n "$signature" ] || fail "sign_update gave no signature."
"$bin/sign_update" --verify "$dmg" "$signature" >/dev/null || fail "The signature does not verify."

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
"$bin/sign_update" "$out" >/dev/null
"$bin/sign_update" --verify "$out" >/dev/null || fail "The feed's signature does not verify."
xmllint --noout "$out"
echo "› $out: Peryda $short (build $build); update and feed signatures verified"
