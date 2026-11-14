<!-- Generated from shared/privacy.json by web/scripts/export-privacy.ts: edit that file, not this one. -->

# Privacy

*Peryda for Mac, Windows and the web · Last updated 15 November 2026*

[Türkçe](docs/privacy/tr.md) · [Deutsch](docs/privacy/de.md) · [Español](docs/privacy/es.md)

## In short

- There is no account and no Peryda server; no analytics, no advertising and no tracking. Nothing you read, write or ask reaches the developer.
- The Mac and Windows apps look for new versions only if you allow it.
- Your books, threads, notes and settings stay on your device.
- When you ask Pery, the request goes straight from your device to the AI provider you chose, with your own key. That provider handles it under its own terms.

This covers Peryda for Mac, Windows and the web. The Peryda iPhone and Android apps and Peryda Cloud have their own privacy policy: peryda.com/privacy

## What stays on your device

- The PDF and EPUB files you add, your reading positions, threads and their cards, translations, notes, the Book Journal and your settings. On a Mac they are kept in Peryda's own sandboxed folder, on Windows in Peryda's app data folder for your Windows account, and on the web in this browser's storage for the site. On the web, clearing the site's data deletes them. Removing the app alone does not: to remove everything, first delete your keys in Peryda's Settings, then remove the app; on a Mac also delete the folder Library/Containers/com.isnalcan.peryda.mac in your home folder, and on Windows tick the box that deletes the application data when you uninstall.
- A backup you export is a file you keep. It holds your books and everything you wrote or got in Peryda (threads, translations, extracted pages, the journal), but never your keys, and it is not encrypted.
- On a Mac, the text of a scanned page is read on the Mac itself, with Apple's built-in text recognition, unless you choose “Extract with Pery”, which sends a picture of the page to your provider.
- A book cannot reach the internet: Peryda loads no images, fonts, styles or scripts from the web inside a book.

## How your keys are protected

Your keys are kept only on this device and are sent only to their own provider. In detail:

- On a Mac they are kept in the macOS Keychain, which encrypts them and unlocks them when you log in to your Mac; another app can reach them only if you allow it.
- On Windows and the web they are kept in the app's own storage on this device, encrypted with AES-256. The key that decrypts them is made by the browser engine (on Windows, Microsoft Edge WebView2), which never lets it out, so your keys never appear as plain text in any file.
- Know the limit, too: this encryption is not full protection against someone who can use your account on the computer, or against malware running there. On a shared computer, turn off “Remember keys on this device”: your keys are then never saved and are forgotten when you quit the app (on the web, when you close the page).
- Each key goes over an encrypted connection (HTTPS) to its own provider only, in the request's header, never in the address. On Windows and the web, the app's security policy (Content Security Policy) allows no connection to any address other than its own files and these four providers. Peryda loads no code from the internet and contains no scripts from other companies, such as advertising, analytics or chat widgets.
- Your keys never go into backups or exported files.
- Our advice: create a separate key for Peryda and set a spending limit at your provider. If you think a key has leaked, revoke it on the provider's site; a revoked key stops working at once.
- Peryda is open source: anyone can check in the code how keys are stored and sent (github.com/isnalcan/peryda-open).

## What goes to your AI provider

Only when you ask for something (a question in a thread, a page translation, a page's text, a journal summary, or the list of models your key can use) does the app send your provider what that request needs:

- your request and the earlier messages of that thread;
- the text you selected with a short passage around it, or a picture of the part of the page you selected;
- the book's title and the page number;
- for a page translation, the page's text, or a picture of the page when it has no text of its own; when you choose “Extract with Pery”, a picture of each page you picked;
- for a journal summary, that book's journal entries.

Only the pages you ask for are sent, and nothing is sent on its own; a page range (at most 200 pages at a time) sends each of its pages. Requests travel over an encrypted connection (HTTPS) straight to the provider; there is no Peryda server in between.

When you translate or extract more than two pages at once with Gemini, they go as a batch job at half the price. Google runs a job for at most 48 hours. Peryda deletes the job at Google once the results are back (while that book is open in Peryda), when you stop, or when you change your Gemini key. Google does not say how long it keeps a finished job that has not been deleted.

## Your provider's terms

The provider decides how long it keeps what it receives and what it may use it for. Read its terms before you send personal or confidential text. Worth knowing:

- Google Gemini API: Google says that on the free tier it uses what you send to improve its products and that human reviewers may read it, and that on the paid tier it does not use it that way. It requires Gemini API users to be 18 or older. Terms: ai.google.dev/gemini-api/terms
- DeepSeek says it stores data in the People's Republic of China. Privacy policy: deepseek.com
- OpenAI: openai.com/policies · Anthropic (Claude): anthropic.com/legal/privacy

## Downloads, the web app and updates

- When you download Peryda from GitHub, GitHub's privacy statement applies to that download.
- The web app is served by Google Firebase Hosting, which processes connection details such as your IP address to deliver its files. Peryda has not added any analytics or request logging to it.
- On Windows, Peryda runs in Microsoft Edge WebView2, a part of Windows that Microsoft keeps up to date.
- The Mac and Windows apps never look for a new version without your permission. They ask on the second start; if you allow it, they fetch a small version file from GitHub about once a day. Like any web request, this lets GitHub see your IP address and the name and version of the app making it. Nothing about your books, notes, keys or computer is sent. You can turn this check on or off in Settings at any time.
- An update is installed only if it is signed with Peryda's update key; a file with a wrong signature, or one that has been altered, is refused. When a new version is found, the app asks before installing it; on a Mac you can also choose to have updates installed automatically.
- The web app checks nothing separately: each time you open the page you get the newest version.

## Your rights

Because the developer receives no personal data through these apps, the developer holds nothing to show, correct or delete; you can delete everything yourself as described above. For what a provider holds, contact that provider. Peryda does not ask your age and keeps no accounts; AI providers set their own minimum age.

## Changes and contact

Changes to this text show in the project's history on GitHub: github.com/isnalcan/peryda-open. Privacy questions: privacy@peryda.com. For security problems, see SECURITY.md in the project.
