#!/bin/sh
# Replaces Peryda's two update signing keys with new ones, then helps you keep the new private halves
# in the Passwords app. Run it yourself in Terminal, before the first public release:
#
#   scripts/rotate-update-keys.sh
#
# Why (15 Nov 2026): copies of the first keys may have reached iCloud (Desktop, Notes). No reader has
# Peryda's old public keys yet, so replacing them now costs nothing; afterwards the old copies are
# worthless. The test builds already installed will not update by themselves: install the new files.
#
# What it does:
#   1. removes the old Mac key from this Mac's login keychain and deletes the old Windows key file;
#   2. runs scripts/update-keys.sh, which makes new keys (it asks you to choose a password for the
#      Windows key) and writes their public halves into mac/project.yml and tauri.conf.json;
#   3. puts each new private key on the clipboard, one at a time, for you to paste into Passwords,
#      then clears the clipboard. Nothing is printed and no copy is left in a file.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
win_key="$HOME/.tauri/peryda-update.key"

printf 'This replaces both of Peryda'"'"'s update keys. Type "yes" to go on: '
read -r answer
[ "$answer" = "yes" ] || { echo "Nothing changed."; exit 1; }

echo "› Removing the old Mac key from the login keychain"
security delete-generic-password -s "https://sparkle-project.org" -a ed25519 >/dev/null 2>&1 || echo "  (there was none)"

echo "› Removing the old Windows key"
rm -f "$win_key" "$win_key.pub"

echo "› Making the new keys"
"$root/scripts/update-keys.sh"
echo ""
echo "  (The backup steps printed above are done for you below.)"

echo ""
"$root/scripts/backup-update-keys.sh"
