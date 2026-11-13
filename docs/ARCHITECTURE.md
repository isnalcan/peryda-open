# Architecture

Peryda runs in three places: a native Mac app, a Windows app and the browser. All three read the
reader's own PDF and EPUB files and add **İlmek** threads: a passage or a page region tied with a yarn
to a margin card where an AI model answers, using the reader's own API key.

## Repository

```
shared/   the contract both engines read: design tokens, thread kinds, prompts in four languages
          (tr, en, de, es), UI strings, and test vectors that both engines are tested against
web/      the reading engine for the browser and the Windows app (React, TypeScript, Vite, pdf.js, epub.js)
windows/  the Windows shell: Tauri v2 around web/ (WebView2), NSIS installer
mac/      the native Mac app: SwiftUI, AppKit, PDFKit, WebKit (PerydaKit = core library + PerydaMac app)
```

The thread logic is written twice, in TypeScript (`web/src/ilmek`) and Swift (`mac/PerydaKit`), and both
are checked against the same vectors in `shared/vectors` so they place cards, draw yarns and choose
providers the same way.

## Data stays on the device

- Books, threads, the Book Journal, reading positions and preferences are stored locally: IndexedDB in
  the browser and on Windows, files in the app container on the Mac. There is no Peryda server and no
  account.
- A backup is a single zip the reader exports and imports themselves. Keys are never in it.

## AI requests (bring your own key)

- Providers: Google Gemini, OpenAI, DeepSeek, Anthropic Claude. Requests go straight from the device to
  the chosen provider over HTTPS, with the key in a request header, never in a URL.
- Keys: Mac Keychain; in the browser and on Windows, IndexedDB, scrambled with a non-extractable AES-GCM
  key (WebCrypto) so they are never stored as plain text and never go into backups. The browser keeps
  that AES key in the same profile, so this does not protect the keys from anyone who can read this
  computer account's browser data. With "remember" off they are not stored at all.
- Whole-page translation of more than two pages uses Gemini batch jobs (the job and its result are held
  by Google until the app collects and deletes them, or they expire; a job no page waits for any more is
  cancelled); other providers translate page by page.
- AI answers are treated as untrusted text: they are rendered by a small Markdown renderer that builds
  elements directly and never inserts HTML.

## Untrusted books

- PDF: rendered by pdf.js (web) or PDFKit (Mac); PDF scripting is not used.
- EPUB: book scripts never run. The web engine cleans each chapter (DOMPurify: no scripts, frames,
  forms, event handlers, outside links or prefetch hints) and shows it in a sandboxed frame with scripts
  blocked; the Mac app cleans each chapter and shows it in WebKit with JavaScript off for the book and
  network access blocked.
- The web page carries a strict Content Security Policy: only its own files, plus connections to the four
  providers.

## Platforms

- **Web**: static files; no server code.
- **Windows**: the same web engine in a Tauri window; the shell exposes no native commands to the page.
- **Mac**: App Sandbox, hardened runtime, Developer ID signing and Apple notarization for downloads.
