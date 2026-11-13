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
