# PokeRogueOffline

A fully offline wrapper for PokéRogue, available on iOS, Android, Windows, and Linux. Play fully offline with local saves, or import your save from [pokerogue.net](https://pokerogue.net).

## Features

- Fully offline — no internet required after install
  - Exception: Starting a daily run will *attempt* to connect to this repo, but is not required.
- Local saves that persist between sessions
- Import saves from your online account
- Based on the latest `main` branch of [pagefaultgames / pokerogue](https://github.com/pagefaultgames/pokerogue/)

## What's New

### New Features
- Added a **Clear All Data** option in Settings → Offline — this deletes all current data. **USE WITH CAUTION**.
- This is the **only** offline client that loads the actual server daily seed. Useful when there are special event daily runs.
- Includes the build number in the banner for support reasons.

### Changes to How the App is Built
The app pulls directly from the official PokéRogue source and applies a small set of targeted fixes on top of it. This means the app will always be up to date with whatever the official game ships, with no manual syncing required.

---

# iOS

## Getting the IPA

Go to the [Releases](https://github.com/PokeRogue-Offline/pokerogue-offline/releases) and download `PokeRogueOffline.ipa` from the latest release.

## Installing the IPA

### Option 1: LiveContainer + SideStore (Recommended — unlimited apps)

LiveContainer lets you run IPAs inside a container without using up your sideloading slots.

**First-time setup:**
1. Install **iLoader** on your PC/Mac from [GitHub](https://github.com/nab138/iloader)
2. Connect your iPhone via USB and open iLoader
3. Sign in with your Apple ID
4. Select **LiveContainer + SideStore** and install it
5. Open LiveContainer on your device and complete the setup (import certificate from SideStore)

**Installing PokeRogueOffline:**
1. Download `PokeRogueOffline.ipa` to your iPhone (via Safari or Files)
2. Open LiveContainer and tap the **+** button in the top right
3. Select the IPA file
4. Tap the app to launch it

> **Note:** LiveContainer signs the app with your SideStore certificate automatically — no manual signing needed.

---

### Option 2: SideStore (without LiveContainer)

SideStore lets you sideload up to 3 apps and refresh them wirelessly without a PC after setup.

1. Install SideStore using iLoader or AltServer
2. Open SideStore and tap **+** in My Apps
3. Select `PokeRogueOffline.ipa`
4. Apps must be refreshed every 7 days (can be automated with a Shortcuts automation)

---

### Option 3: Feather / Sideloadly

If you already use Feather or Sideloadly, just sign and install the IPA as you normally would.

---

# Android

Go to the [Releases](https://github.com/PokeRogue-Offline/pokerogue-offline/releases) and download `PokeRogueOffline.apk` from the latest release.

- Enable "Install from Unknown Sources" in Settings
- Download and install the APK
- Note: APK is debug-signed, you may need to allow installation

---

# Windows

Go to the [Releases](https://github.com/PokeRogue-Offline/pokerogue-offline/releases) and download `PokeRogueOffline.exe` from the latest release.

- Run the EXE directly — no installation required
- **Requires WebView2**, which ships with Windows 11 and is installed automatically on Windows 10 via Windows Update. If you get an error on launch, download it from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

---

# Linux

Go to the [Releases](https://github.com/PokeRogue-Offline/pokerogue-offline/releases) and download `PokeRogueOffline.AppImage` from the latest release.

- Make the file executable: `chmod +x PokeRogueOffline.AppImage`
- Run it: `./PokeRogueOffline.AppImage`
- **Requires WebKitGTK**. Most desktop Linux distributions (Ubuntu 24.04+, Fedora 40+, etc.) include this by default. If the app fails to launch, install it with:
  - Ubuntu/Debian: `sudo apt install libwebkit2gtk-4.1`
  - Fedora: `sudo dnf install webkitgtk6.0`
  - Arch: `sudo pacman -S webkit2gtk-4.1`

---

## Importing your save

1. Go to [pokerogue.net](https://pokerogue.net) on a browser and log in
2. Navigate to **Pause → Manage Data → Export Save**
3. Open PokeRogueOffline and navigate to **Pause → Manage Data → Import Save**
4. Select the exported file

## In-app updates

The apps update themselves from this repo's GitHub releases, with no update server and no tracking. Releases that only change the game's web content are delivered as small content updates on every platform; releases that change the app itself are full updates. On Windows, Linux and macOS a content update is downloaded while you play and installed the next time the game starts. See [docs/OTA.md](docs/OTA.md) for the design.

## Notes

- This app is for personal use only
- Saves are stored locally and are not synced to any server
- This is an unofficial fan project and is not affiliated with the PokéRogue team
