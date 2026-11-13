# Peryda for Mac, Windows and the web

Peryda is a calm place to read your own PDF and EPUB files. These apps add **İlmek**: threads that run
from a sentence or a page region to margin cards where Pery, the reading companion, explains, compares or
simplifies, and where you keep your own notes.

The apps use **your own AI key** (Google Gemini, OpenAI, DeepSeek or Anthropic Claude). Requests go straight from your device to the
provider you choose. There is no Peryda server in between and nothing to buy.
What stays on your device and what goes to your provider is set out in [PRIVACY.md](PRIVACY.md)
(also in [Türkçe](docs/privacy/tr.md), [Deutsch](docs/privacy/de.md) and [Español](docs/privacy/es.md)).

- `shared/` design tokens, İlmek kinds and prompts in four languages, shared test vectors
- `web/` the reading engine for the browser and the Windows app (React, TypeScript, pdf.js)
- `windows/` the Windows shell (Tauri)
- `mac/` the native Mac app (SwiftUI, AppKit, PDFKit)
- `docs/` [architecture](docs/ARCHITECTURE.md) and [building](docs/BUILDING.md)

Status: early development.

## Your keys

- **Mac:** kept in the macOS Keychain.
- **Windows and web:** kept in the app's own storage on your device, encrypted with AES-256 under a key
  the browser engine generates and never lets out. This keeps keys out of files as plain text; it does
  not protect against someone who can use your account on that computer, so on a shared computer turn
  off "Remember keys on this device".
- Each key is sent only to its own provider, over HTTPS, in a request header. On Windows and the web the
  Content Security Policy allows connections only to the app's own files and the four providers.
- Keys never go into backups or exports. We recommend a separate key with a spending limit.

The code that does this: [`web/src/data/keyVault.ts`](web/src/data/keyVault.ts) and
[`mac/PerydaKit/Sources/PerydaKit/Store/KeyVault.swift`](mac/PerydaKit/Sources/PerydaKit/Store/KeyVault.swift).

## Updates

The web app is always the newest version. The Mac and Windows apps look for a new version only if you
allow it (they ask on the second start, and Settings can change it): about once a day they fetch a
small file from this repository's latest GitHub release, and they install only updates signed with
Peryda's update key.

## Licence

The code is released under the [MIT licence](LICENSE); see [NOTICE](NOTICE) for what it does not cover (the
Peryda name and artwork, the fonts, third-party components). To report a security problem, see
[SECURITY.md](SECURITY.md).

The name **Peryda**, the Peryda logo and the brand artwork (`web/public/brand/`, the app icons in
`mac/` and `windows/`) are not covered by that licence: please do not use them for other apps or
in a way that suggests your build is the official Peryda.
