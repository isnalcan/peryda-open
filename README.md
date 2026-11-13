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

## Licence

The code is released under the [MIT licence](LICENSE); see [NOTICE](NOTICE) for what it does not cover (the
Peryda name and artwork, the fonts, third-party components). To report a security problem, see
[SECURITY.md](SECURITY.md).

The name **Peryda**, the Peryda logo and the brand artwork (`web/public/brand/`, the app icons in
`mac/` and `windows/`) are not covered by that licence: please do not use them for other apps or
in a way that suggests your build is the official Peryda.
