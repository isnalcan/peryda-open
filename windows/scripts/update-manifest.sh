#!/bin/sh
# Signs a finished Windows installer for the update check and writes latest.json next to it. Run it on
# the Mac once the installer is final (built by the "Windows build" workflow and, once SignPath signs
# releases, after that signature), because the update signature must cover the exact file readers get.
#
#   windows/scripts/update-manifest.sh ~/Downloads/Peryda_0.1.1_x64-setup.exe [notes.txt]
#
# It asks for the Windows update key's password (chosen in scripts/update-keys.sh). The signature also
# carries the version, so a forged latest.json cannot pass an old installer off as a new one
# (requireSignedVersion). Upload the installer and latest.json to the GitHub release v<version>.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
exe=${1:?usage: update-manifest.sh <Peryda_x.y.z_x64-setup.exe> [notes.txt]}
notes=${2:-}
key=${PERYDA_WINDOWS_UPDATE_KEY:-$HOME/.tauri/peryda-update.key}
repo=${PERYDA_REPO:-isnalcan/peryda-open}
conf="$here/src-tauri/tauri.conf.json"

fail() {
  echo "$1" >&2
  exit 1
}

version=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$conf")
name="Peryda_${version}_x64-setup.exe"
[ "$(basename "$exe")" = "$name" ] || fail "Expected $name (the version in tauri.conf.json is $version)."
[ -f "$key" ] && [ -f "$key.pub" ] || fail "No Windows update key at $key. Run scripts/update-keys.sh."
pubkey=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).plugins.updater.pubkey)' "$conf")
[ "$pubkey" = "$(cat "$key.pub")" ] || fail "tauri.conf.json carries a different update key than $key.pub."

rm -f "$exe.sig"
(cd "$here" && npx --no-install tauri signer sign -f "$key" --app-version "$version" "$exe")
[ -s "$exe.sig" ] || fail "No signature was written."

out="$(dirname "$exe")/latest.json"
node -e '
  const fs = require("fs")
  const [version, sigFile, url, notesFile] = process.argv.slice(1)
  const manifest = {
    version,
    notes: notesFile ? fs.readFileSync(notesFile, "utf8").trim() : "",
    pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: { "windows-x86_64": { signature: fs.readFileSync(sigFile, "utf8").trim(), url } },
  }
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n")
' "$version" "$exe.sig" "https://github.com/$repo/releases/download/v$version/$name" "$notes" > "$out"
echo "› $out: Peryda $version for Windows, signed with the update key"
