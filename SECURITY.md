# Security

## Reporting a problem

Please report security problems privately, not in a public issue: use GitHub's
**Report a vulnerability** button on this repository's Security tab. You will get a reply within a
few days. Please include the platform (Mac, Windows, web), the version and the steps to reproduce.

## What Peryda protects

- Your API keys: kept only on your device and sent only to their own provider.
- Your books, threads and notes: kept only on your device; no Peryda server, no account, no telemetry.
- Untrusted input: book files, backup files and AI answers must never run code, reach the network on
  their own or change files outside Peryda's own data.
- Updates: the Mac and Windows apps check only if the reader allows it, and install only updates signed
  with Peryda's update keys (with a signed feed on the Mac and a version-bound signature on Windows).

Reports about any of these are very welcome.
