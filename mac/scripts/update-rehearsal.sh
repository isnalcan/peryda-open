#!/bin/sh
# Update rehearsal on this Mac, before any release: checks that a Developer ID Peryda really updates itself
# (Sparkle in the sandbox, the installer service, both signatures) without publishing anything.
#
# Builds Peryda 0.1.0 (build 1) and 0.1.1 (build 2) like a release but with nothing sent to Apple
# (release.sh --sign-only), both reading updates from this Mac's own http://127.0.0.1:<port>/appcast.xml.
# Signs the 0.1.1 disk image and the feed with the real update key (the keychain may ask once), puts the
# old app and the feed in ~/tmp/peryda-update-rehearsal, and says how to start the test. The feed and the
# update are signed, so plain HTTP on 127.0.0.1 changes nothing about what is checked.
#
#   mac/scripts/update-rehearsal.sh
#
# Settings (environment): PORT (default 8765). Nothing here is uploaded; release.sh refuses these builds
# as releases, and their disk images are named …-REHEARSAL.dmg.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
port=${PORT:-8765}
dir="$HOME/tmp/peryda-update-rehearsal"
base="http://127.0.0.1:$port"
old=0.1.0
new=0.1.1

rm -rf "$dir"
mkdir -p "$dir/feed"

echo "› Building $old (build 1) and $new (build 2), both reading $base/appcast.xml"
PERYDA_VERSION=$old PERYDA_BUILD=1 PERYDA_UPDATE_FEED_URL="$base/appcast.xml" "$here/scripts/release.sh" --sign-only
PERYDA_VERSION=$new PERYDA_BUILD=2 PERYDA_UPDATE_FEED_URL="$base/appcast.xml" "$here/scripts/release.sh" --sign-only

# The old app comes out of its disk image, as a reader would copy it.
mnt=$(mktemp -d "${TMPDIR:-/tmp}/peryda-rehearsal.XXXXXX")
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" -quiet "$here/build/Peryda-$old-REHEARSAL.dmg"
ditto "$mnt/Peryda.app" "$dir/Peryda.app"
hdiutil detach "$mnt" -quiet
rmdir "$mnt"

cp "$here/build/Peryda-$new-REHEARSAL.dmg" "$dir/feed/Peryda-$new.dmg"
PERYDA_DOWNLOAD_BASE="$base" "$here/scripts/appcast.sh" "$dir/feed/Peryda-$new.dmg"
cp "$here/build/rehearsal/appcast.xml" "$dir/feed/appcast.xml"

echo "› Ready in $dir"
echo "  1. python3 -m http.server $port --bind 127.0.0.1 --directory \"$dir/feed\""
echo "  2. open \"$dir/Peryda.app\", then Peryda → Check for Updates… → Install Update → Install and Relaunch"
echo "  3. Afterwards the app in $dir should say $new: PlistBuddy -c 'Print :CFBundleShortVersionString' \"$dir/Peryda.app/Contents/Info.plist\""
