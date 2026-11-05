# Fjord

A private browser built on Firefox. Ads and trackers are blocked from the first page you open, there's no telemetry,
and the settings explain what each choice costs.

Fjord isn't a fork: it's the official Firefox from Mozilla, set up with Firefox's own configuration files
(`Fjord.cfg`, `policies.json`) and a layer of window scripts and styles in `src/fjord/`. That's why it can
follow every Firefox security update the day it ships.

## What's in it

- **Shields** in the address bar: a protection dial per site (Off, Standard, Strict, Lockdown) and which companies the
  page tried to share your visit with
- uBlock Origin built in, Firefox's strict tracker blocking, fingerprinting protection, HTTPS-only, Secure DNS (Quad9)
- **Ghost mode** (forget everything on close, with per-site exceptions), **Mist tabs** (throwaway tabs)
- Warnings for **lookalike sites** (paypa1.com), **clipboard hijacking**, sites using your camera, microphone or location
- **Skips tracking redirects** (google.com/url?q=…), **App lock** with Windows Hello / Touch ID
- **Fjord's connections**: a live list of every connection Fjord itself makes
- Sidebar apps (Spotify, WhatsApp…), Workspaces, Memory saver, design tools (colour picker, font finder, asset saver,
  full-page screenshots)
- A new tab with 100 hand-picked Unsplash photos and privacy stats

## Layout

| Path | What it is |
|---|---|
| `build.ps1` | Builds Fjord for Windows into `dist\` (downloads Firefox from Mozilla, checks its signature) |
| `tools/install.sh` | Installs and updates Fjord on a Mac or Linux (downloads Firefox from Mozilla, checks its signature) |
| `build-mac.sh` | Installs Fjord on a Mac from this checkout (`tools/install.sh` with `FJORD_SRC`) |
| `src/Fjord.cfg` | Firefox's autoconfig: Fjord's default settings, and loads everything below |
| `src/policies.json` | Firefox enterprise policies (uBlock Origin, tracking protection, no telemetry) |
| `src/fjord/browser.js` | Window script: new tab, setup, settings, sidebar apps, lookalike warning |
| `src/fjord/shields.js` | The Shields button and panel |
| `src/fjord/features/` | One script per feature (memory saver, Mist tabs, design tools, app lock…) |
| `src/fjord/*.sys.mjs` | Shared modules: privacy watch, uBlock bridge, permissions, Mist, app lock, sidebar apps |
| `src/fjord/page-frame.js` | Runs inside web pages: permission watch, clipboard guard, design tools |
| `src/fjord/chrome.css` | Fjord's look |
| `tools/installer/` | The Windows installer, updater and uninstaller (C#, built by `tools\build-installer.ps1`) |
| `tools/release.ps1` | Publishes a signed release on GitHub |
| `.github/workflows/build.yml` | Builds the installer on GitHub and has SignPath sign it (started by `tools\release.ps1`) |
| `tools/photos.txt` | The new-tab photos; `tools\get-photos.ps1` downloads them |
| `docs/` | The website (served by GitHub Pages) |

## Building

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File tools\get-photos.ps1      # once: the new-tab photos
powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1 # Fjord in dist\ and dist\FjordSetup.exe
```

Mac (quit Fjord first; it installs to /Applications):

```sh
sh build-mac.sh
```

Linux, from this checkout:

```sh
FJORD_SRC="$PWD" sh tools/install.sh
```

People install the latest release on a Mac or Linux with
`curl -fsSL https://github.com/Elias-Mathisen/fjord/releases/latest/download/install.sh | sh`, and remove it with
`sh ~/Library/Application\ Support/Fjord/updater/install.sh --uninstall` (Mac) or
`sh ~/.local/share/fjord/updater/install.sh --uninstall` (Linux).

## Releasing

Fjord's version is in `src/fjord/version.txt`. Raise it, commit, then:

```powershell
powershell -ExecutionPolicy Bypass -File tools\release.ps1 "What's new"
```

That pushes, has GitHub build `FjordSetup.exe` and the Mac and Linux files (`fjord-files.tar.gz`) from the pushed code
(`.github/workflows/build.yml`), where SignPath signs the installer for Windows, then signs both with Fjord's release
key on your PC and publishes them, with `install.sh`, as a GitHub release.
Installed copies check for it every 3 hours and only take an update signed with that key. The key is made once by
`tools\make-release-key.ps1`; its private half stays in `%APPDATA%\Fjord release\` and must be backed up.

Checks for the privacy rules can be pasted into Fjord's Browser Console (Ctrl+Shift+J): `tools/test-lookalike.js`,
`tools/test-redirects.js`.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

- Committers and reviewers: [Elias Mathisen](https://github.com/Elias-Mathisen)
- Approvers: [Elias Mathisen](https://github.com/Elias-Mathisen)

Only `FjordSetup.exe`, built by GitHub from this repository's code, is signed, and every release is approved by hand.
Firefox itself is downloaded from Mozilla by the installer and keeps Mozilla's own signature.

## Privacy

Fjord collects nothing about you: there's no account, no usage data and no ads, and your settings, history and
passwords stay on your computer. It doesn't send information to other computers unless you ask it to, apart from
the connections it needs to work, which it lists live in Settings under **Fjord's connections**:

- **The installer and updater:** Firefox and its version number from Mozilla (mozilla.org), new versions of Fjord
  from GitHub, and the new-tab photos from Unsplash (images.unsplash.com)
- **The browser:** security lists, blocklists and tracker lists from Mozilla, Safe Browsing lists of dangerous sites
  (only short fingerprints of addresses are sent), filter list updates for uBlock Origin, Secure DNS through Quad9,
  certificate checks, and video codecs (Mozilla, Google, Cisco)
- **Only when you use them:** site notifications you allowed, your location when a site asks and you allow it, and the
  sidebar apps you add

Firefox's own telemetry is switched off.

## License

Fjord's own code is under the [Mozilla Public License 2.0](LICENSE), the same license as Firefox.

## Credits

Built on [Firefox](https://www.mozilla.org/firefox/) by Mozilla and [uBlock Origin](https://github.com/gorhill/uBlock)
by Raymond Hill. Firefox and the Firefox logos are trademarks of the Mozilla Foundation; Fjord is not made or endorsed
by Mozilla. New-tab photos from [Unsplash](https://unsplash.com) (Unsplash License), credited on each tab. Font:
[Geist](https://vercel.com/font) by Vercel (SIL Open Font License).
