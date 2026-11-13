# Building

## Web

Node 24 or newer (npm 11).

```bash
cd web
npm ci
npm test          # unit and component tests (Vitest)
npm run dev       # http://localhost:5191
npm run build     # static files in web/dist
```

## Mac

Xcode 26, [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
cd mac/PerydaKit && swift test         # core tests
cd mac && xcodegen generate            # PerydaMac.xcodeproj from project.yml
```

Keep Xcode's derived data outside folders synced by iCloud: their extended attributes break code
signing.

A downloadable build needs a *Developer ID Application* certificate in the keychain and a stored
notarytool profile (`xcrun notarytool store-credentials peryda-notary …`). Then:

```bash
mac/scripts/release.sh           # signed, notarized, stapled DMG in mac/build
mac/scripts/release.sh --local   # signed for this Mac only, to try the DMG
```

## Windows

Rust (stable) and Node 24. The installer is built on Windows:

```bash
npm ci --prefix web
npm ci --prefix windows
cd windows && npx tauri build    # NSIS installer in src-tauri/target/release/bundle/nsis
```

The GitHub workflow `.github/workflows/windows.yml` does the same on GitHub's Windows machine and is
started by hand. On a Mac, `npx tauri build --no-bundle` only checks that the shell compiles.

## Hosting the web app

`firebase.json` serves `web/dist` with the same Content Security Policy as an HTTP header (which,
unlike the page's meta tag, also covers the pdf.js worker and forbids framing) plus the usual security
headers. Keep its CSP identical to the one in `web/vite.config.ts`.

## Updates (Mac and Windows)

The web app is always the newest version. The Mac app (Sparkle) and the Windows app (Tauri's updater)
ask the reader before their first check, then look about once a day at the latest GitHub release of
this repository and install only updates signed with Peryda's update keys. The Mac feed is signed too
(`SURequireSignedFeed`), and the Windows signature carries the version (`requireSignedVersion`), so a
forged feed cannot offer an old release as a new one.

Once, on the release Mac:

```bash
scripts/update-keys.sh    # makes both keys, writes their public halves into the projects
```

The private keys stay on that Mac (the Mac key in the login keychain, the Windows key in
`~/.tauri/peryda-update.key` with a password) and never in the repository. Keep a backup: without
them no update can be signed.

Every release:

1. Raise the version: `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `mac/project.yml`
   (Sparkle compares the build number), and `version` in `windows/src-tauri/tauri.conf.json` and
   `windows/src-tauri/Cargo.toml`.
2. Mac: `mac/scripts/release.sh`, then `mac/scripts/appcast.sh mac/build/Peryda-X.Y.Z.dmg [notes.html]`.
3. Windows: run the *Windows build* workflow, download the installer (after SignPath's signature, once
   releases are signed), then `windows/scripts/update-manifest.sh Peryda_X.Y.Z_x64-setup.exe [notes.txt]`.
4. Publish the GitHub release `vX.Y.Z` with `Peryda-X.Y.Z.dmg`, `appcast.xml`,
   `Peryda_X.Y.Z_x64-setup.exe` and `latest.json`. The apps read `appcast.xml` and `latest.json` from
   the latest release, so every release carries both; when a release changes only one platform, attach
   the other platform's feed file from the previous release unchanged (it is signed, so do not edit it).

