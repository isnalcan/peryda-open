# Code signing policy

**Windows:** free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/). *Status: we have applied to the SignPath Foundation
program. Until the application is approved, the Windows installer is not code-signed and Windows
SmartScreen may warn that the publisher is unknown.*

**Mac:** signed with the maintainer's Apple Developer ID certificate and notarized by Apple.

## What is signed

Only release builds of this repository's own source code:

- The Windows installer (`Peryda_X.Y.Z_x64-setup.exe`, also published as `Peryda-Setup.exe`) is built by
  the [Windows build](.github/workflows/windows.yml) workflow on GitHub-hosted runners, from a commit on
  `main`, with every action pinned to a commit. The same workflow runs the web tests and a smoke test of
  the installed app before anything is released.
- The Mac disk image is built from a committed `main` with `mac/scripts/release.sh` (see
  [docs/BUILDING.md](docs/BUILDING.md)).

Nothing built from someone else's code, and nothing outside a release, is signed. Every signing request
is approved by hand for each release.

## Team roles

Peryda is maintained by one person, [@isnalcan](https://github.com/isnalcan), who holds every role:

- **Authors (committers):** [@isnalcan](https://github.com/isnalcan)
- **Reviewers** (review changes from people who are not committers): [@isnalcan](https://github.com/isnalcan)
- **Approvers** (approve each signing request): [@isnalcan](https://github.com/isnalcan)

All team members use multi-factor authentication for GitHub and for SignPath.

## Privacy

Peryda has no server, no account, no analytics and no ads. It sends something over the network only when
you ask it to: a question to the AI provider whose key you entered, a download of a newer version if you
allowed update checks. What goes where is set out in [PRIVACY.md](PRIVACY.md).

## Uninstalling

- **Windows:** Settings → Apps → Installed apps → Peryda → Uninstall (the installer adds a standard
  uninstaller; tick the box to remove its data too).
- **Mac:** quit Peryda and move it from Applications to the Trash; [PRIVACY.md](PRIVACY.md) says how to
  remove its data as well.
- **Web:** clear the site data for app.peryda.com in your browser.
