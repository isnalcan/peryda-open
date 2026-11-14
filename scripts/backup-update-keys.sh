#!/bin/sh
# Puts Peryda's two private update keys on the clipboard, one at a time, for you to paste into the
# Passwords app, then clears the clipboard. Nothing is printed and no copy is left in a file. Run it
# yourself in Terminal:
#
#   scripts/backup-update-keys.sh
#
# (scripts/rotate-update-keys.sh runs it at the end.)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
win_key="$HOME/.tauri/peryda-update.key"

dir=$(mktemp -d "${TMPDIR:-/tmp}/peryda-key.XXXXXX")
chmod 700 "$dir"
trap 'rm -rf "$dir"; printf "" | pbcopy' EXIT

# $1: the file holding the key; $2: which key it is. Waits for Return from the keyboard, not the file.
clip_then_clear() {
  pbcopy < "$1"
  echo ""
  echo "  The $2 update key is on the clipboard now."
  echo "  In Passwords, make a new entry (for example \"Peryda update key - $2\"), paste it into the"
  printf '  password field, save, then press Return here: '
  read -r _ < /dev/tty
  printf '' | pbcopy
  echo "  Clipboard cleared."
}

echo "› Keeping the private update keys in Passwords"
bin=$("$root/mac/scripts/sparkle-bin.sh")
"$bin/generate_keys" -x "$dir/mac.key" >/dev/null
clip_then_clear "$dir/mac.key" "Mac"
rm -f "$dir/mac.key"

[ -f "$win_key" ] || { echo "No Windows update key at $win_key. Run scripts/update-keys.sh first." >&2; exit 1; }
clip_then_clear "$win_key" "Windows"
echo ""
echo "  Also keep the Windows key's password in that Windows entry (for example in its notes)."
echo ""
echo "Done. Tell Claude it is done: the new public keys need to be committed."
