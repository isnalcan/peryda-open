<!-- Generated from shared/privacy.json by web/scripts/export-privacy.ts: edit that file, not this one. -->

# Privacy

*Peryda for Mac, Windows and the web · Last updated 13 November 2026*

[Türkçe](docs/privacy/tr.md) · [Deutsch](docs/privacy/de.md) · [Español](docs/privacy/es.md)

## In short

- There is no account and no Peryda server; no analytics, no advertising and no tracking. Nothing you read, write or ask reaches the developer.
- Your books, threads, notes and settings stay on your device.
- When you ask Pery, the request goes straight from your device to the AI provider you chose, with your own key. That provider handles it under its own terms.

This covers Peryda for Mac, Windows and the web. The Peryda iPhone and Android apps and Peryda Cloud have their own privacy policy: peryda.com/privacy

## What stays on your device

- The PDF and EPUB files you add, your reading positions, threads and their cards, translations, notes, the Book Journal and your settings. On a Mac they are kept in Peryda's own sandboxed folder, on Windows in Peryda's app data folder for your Windows account, and on the web in this browser's storage for the site. Removing the app or clearing the site's data deletes them.
- Your AI keys: on a Mac in the macOS Keychain; on Windows and the web in the app's own storage, encrypted with a key the browser engine never lets out. Someone who can use your account on the computer could still reach them, so on a shared computer turn off “Remember keys on this device”. Each key is only ever sent to its own provider.
- A backup you export is a file you keep. It never contains your keys and is not encrypted.
- On a Mac, the text of a scanned page is read on the Mac itself, with Apple's built-in text recognition.
- A book cannot reach the internet: Peryda loads no images, fonts, styles or scripts from the web inside a book.

## What goes to your AI provider

Only when you ask for something (a question in a thread, a page translation, a page's text, a journal summary, or the list of models your key can use) does the app send your provider what that request needs:

- your request and the earlier messages of that thread;
- the text you selected with a short passage around it, or a picture of the part of the page you selected;
- the book's title and the page number;
- for a page translation, the page's text; on Windows and the web, a picture of the page when it has no text of its own (also when you ask for a page's text);
- for a journal summary, that book's journal entries.

Your whole book is never sent. Requests travel over an encrypted connection (HTTPS) straight to the provider; there is no Peryda server in between.

When you translate many pages at once with Gemini, they go as a batch job at half the price. Google keeps the job until it is done, for at most 48 hours; Peryda deletes it as soon as the translations are back, or when you stop translating.

## Your provider's terms

The provider decides how long it keeps what it receives and what it may use it for. Read its terms before you send personal or confidential text. Worth knowing:

- Google Gemini API: Google says that on the free tier it uses what you send to improve its products and that human reviewers may read it, and that on the paid tier it does not use it that way. It requires Gemini API users to be 18 or older. Terms: ai.google.dev/gemini-api/terms
- DeepSeek says it stores data in the People's Republic of China. Privacy policy: deepseek.com
- OpenAI: openai.com/policies · Anthropic (Claude): anthropic.com/legal/privacy

## Downloads, the web app and updates

- When you download Peryda from GitHub, GitHub's privacy statement applies to that download.
- The web app is served by Google Firebase Hosting, which processes connection details such as your IP address to deliver its files. Peryda has not added any analytics or request logging to it.
- On Windows, Peryda runs in Microsoft Edge WebView2, a part of Windows that Microsoft keeps up to date.
- The apps do not check for updates by themselves.

## Your rights

Because the developer receives no personal data through these apps, the developer holds nothing to show, correct or delete; you can delete everything yourself as described above. For what a provider holds, contact that provider. Peryda does not ask your age and keeps no accounts; AI providers set their own minimum age.

## Changes and contact

Changes to this text show in the project's history on GitHub: github.com/isnalcan/peryda-open. Privacy questions: privacy@peryda.com. For security problems, see SECURITY.md in the project.
