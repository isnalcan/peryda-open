#!/bin/sh
# Makes Peryda's two update signing keys on this Mac (once) and writes their public halves into the
# projects. Run it yourself in Terminal; it may ask the keychain for permission and asks you to choose
# a password for the Windows key:
#
#   scripts/update-keys.sh
#
# Mac (Sparkle): the private key goes into this Mac's login keychain.
# Windows (Tauri): the private key goes to ~/.tauri/peryda-update.key, locked with your password.
# Private keys never go into the repository. Keep a copy somewhere safe (see the end): without them no
# update can be signed, and every reader would have to download the next version by hand.
# Running it again changes nothing: existing keys are kept and only their public halves are written.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)

echo "› Mac update key (Sparkle, in the login keychain)"
bin=$("$root/mac/scripts/sparkle-bin.sh")
if ! mac_key=$("$bin/generate_keys" -p 2>/dev/null); then
  "$bin/generate_keys" >/dev/null
  mac_key=$("$bin/generate_keys" -p)
fi
case "$mac_key" in *[!A-Za-z0-9+/=]* | "") echo "Unexpected public key from generate_keys." >&2; exit 1 ;; esac
sed -i '' "s|^\( *PERYDA_UPDATE_PUBLIC_KEY:\).*|\1 \"$mac_key\"|" "$root/mac/project.yml"
(cd "$root/mac" && xcodegen generate --quiet)

echo "› Windows update key (Tauri, ~/.tauri/peryda-update.key)"
win_key="$HOME/.tauri/peryda-update.key"
if [ ! -f "$win_key" ]; then
  mkdir -p "$HOME/.tauri"
  chmod 700 "$HOME/.tauri"
  echo "  Choose a password for it and keep it in your password manager: every Windows release asks for it."
  (cd "$root/windows" && npx --no-install tauri signer generate -w "$win_key")
fi
chmod 600 "$win_key"
node -e '
  const fs = require("fs")
  const [conf, pub] = process.argv.slice(1)
  const c = JSON.parse(fs.readFileSync(conf, "utf8"))
  c.plugins.updater.pubkey = fs.readFileSync(pub, "utf8").trim()
  fs.writeFileSync(conf, JSON.stringify(c, null, 2) + "\n")
' "$root/windows/src-tauri/tauri.conf.json" "$win_key.pub"

cat <<'TXT'

Done. The public halves are now in mac/project.yml and windows/src-tauri/tauri.conf.json.

Keep a backup of the two private keys somewhere only you can open (a password manager, or an
encrypted USB stick), never in iCloud Drive or the repository. Do not export to the Desktop or
Documents: on a Mac with "Desktop & Documents Folders" in iCloud they are uploaded at once.
  Mac:      mkdir -p ~/tmp && d=$(mktemp -d ~/tmp/peryda-key.XXXXXX) && chmod 700 "$d" &&
            mac/build/dd/SourcePackages/artifacts/sparkle/Sparkle/bin/generate_keys -x "$d/peryda-mac-update.key"
            then put that file straight into the password manager and remove it:
            rm "$d/peryda-mac-update.key" && rmdir "$d"
  Windows:  ~/.tauri/peryda-update.key (and its password)
TXT
