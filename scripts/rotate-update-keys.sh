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

clip_then_clear() {
  # $1: what it is; reads the secret from stdin.
  pbcopy
  echo ""
  echo "  $1 is on the clipboard now."
  echo "  In Passwords, make a new entry (for example \"Peryda update key — $2\"), paste it into the"
  printf '  password field, save, then press Return here: '
  read -r _
  printf '' | pbcopy
  echo "  Clipboard cleared."
}

echo ""
echo "› Keeping the new private keys in Passwords"
dir=$(mktemp -d "${TMPDIR:-/tmp}/peryda-key.XXXXXX")
chmod 700 "$dir"
trap 'rm -rf "$dir"; printf "" | pbcopy' EXIT
bin=$("$root/mac/scripts/sparkle-bin.sh")
"$bin/generate_keys" -x "$dir/mac.key" >/dev/null
clip_then_clear "The Mac update key" "Mac" < "$dir/mac.key"
rm -f "$dir/mac.key"
clip_then_clear "The Windows update key" "Windows" < "$win_key"
echo ""
echo "  Also keep the Windows key's password (the one you just chose) in that Windows entry."
echo ""
echo "Done. Old copies of the previous keys (Notes, iCloud Drive, Recently Deleted) are now worthless;"
echo "delete them when convenient. Tell Claude it is done: the new public keys need to be committed."
