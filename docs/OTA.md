# In-app updates (OTA)

How the Android, iOS, Windows, Linux and macOS apps update themselves from this repo's GitHub releases.

There is no update server and no tracking. The only requests an app makes are to the GitHub API for the release list and to GitHub for the release's own files (the manifest and the zips it decides to download). Nothing about the device is sent, and nothing is measured on the device except locally, to decide whether an update fits on disk.

## Two kinds of update

Every app is a native **shell** around the same web content (`dist/`).

| | What changes | How it is delivered |
|---|---|---|
| **Content update (OTA)** | Only `dist/` | The changed parts of `dist/` are downloaded and swapped in. |
| **Full update** | The shell | Android: the APK is downloaded and handed to the system installer. iOS: notify only (sideload the new IPA). Desktop: the exe / AppImage / `.app` is replaced by `updater.cjs`. |

Which one a release gets is decided per platform by a **fingerprint**: a SHA-256 over the files that make up that platform's shell (`scripts/compute-native-fingerprint.js android|ios|desktop`). Each build has its own fingerprint baked in, and each release's OTA manifest carries the fingerprint it was built with. Equal means the installed shell can run the new content, so the release is offered as a content update. Different means a full update.

`scripts/check-native-fingerprint-coverage.js` runs in CI and fails when a file that can affect a shell is neither hashed nor listed, with a reason, in that script's `EXCLUDED` table.

## Channels and the manifest

`dist/` is split by top-level entry into three channels, so a code-only release does not re-download hundreds of MB of images and audio:

- **code**: `index.html`, Vite's `assets/` chunks, the service worker
- **assets**: `images/`, `audio/`, `fonts/`, `battle-anims/` and a few data files
- **locales**: `locales/`

`scripts/split-ota-bundle.js` produces one zip per channel plus a manifest:

```json
{
  "schemaVersion": 2,
  "version": "1.12.2.6",
  "buildNumber": 368,
  "nativeFingerprint": "<sha256 of the shell>",
  "channel": "stable",
  "code": {
    "version": "<sha256 of the channel's files>",
    "sha256": "<sha256 of the zip>",
    "assetName": "ota-code.zip",
    "bytes": 7050561,
    "entries": 412,
    "unpackedBytes": 21094311
  },
  "assets": { "...": "same fields" },
  "locales": { "...": "same fields" }
}
```

A channel's `version` is a hash of its contents, so a channel is downloaded only when its version differs from the installed one. `bytes`, `entries` and `unpackedBytes` were added later; clients treat them as optional and older clients ignore them.

Release assets:

| Asset | For |
|---|---|
| `PokeRogueOffline-{Android,iOS}-ota-{code,assets,locales}.zip`, `-ota-manifest.json` | Mobile content updates |
| `PokeRogueOffline-{Android,iOS}-ota.zip` | Legacy single bundle, for installs whose updater predates the channel split |
| `PokeRogueOffline-Desktop-ota-{code,assets,locales}.zip`, `-ota-manifest.json` | Desktop content updates. One set for all three desktop platforms; built by the AppImage job |
| `PokeRogueOffline[-dev].{apk,ipa,exe,AppImage}`, `-{x64,arm64}.{dmg,app.tar.gz}` | Full installs and full updates |
| `SHA256SUMS.txt` | Checksums of everything above except the manifests |

**Stable and dev** never cross. Stable builds only match `v<version>-<build>` tags, dev builds only `dev-v<version>-<build>`, and a manifest is only used when its `channel` matches the build. Stable builds ask GitHub for the single latest release; dev builds page the release list, because dev releases are prereleases.

## The state machine

One implementation, `new-files/src/system/offline/ota-core.ts`, is used by both mobile and desktop. It only touches disk through a small filesystem interface. Mobile compiles it into the web bundle (`ota-parts.ts` binds it to Capacitor); the desktop builds transpile it to CommonJS for the Electron main process (`ota-desktop.cjs` binds it to Node).

All three channels live together in one served directory, `ota/active/`. Per channel there is a pointer (`active-<ch>.json`: version, confirmed or not, launch counters), a backup of the last confirmed version, and a staging directory.

Updating a channel:

1. **Stage**: unzip the new version into the staging directory and stamp it complete. Nothing in use is touched.
2. **Swap**: write a marker, move the channel's current entries to the backup, move the staged entries in, write the pointer (unconfirmed), remove the marker.
3. **Confirm**: when the title screen is reached, mark the pointer confirmed and delete the backup.

What goes wrong, and what happens:

| Situation | Result |
|---|---|
| Killed during the swap | The marker is still there at the next launch. If the pointer was already written the swap is finished; otherwise the backup is put back. |
| Killed while writing a state file | State files are written twice, so one complete copy always exists. |
| New content never runs at all | Rolled back to the backup on the third launch. |
| New content runs but never reaches the title screen | Rolled back on the sixth launch. More chances than the row above, because closing the app during a slow first load is not a broken update. |
| Updated again before the previous update confirmed | The backup stays the last confirmed version; the unconfirmed one is discarded. |
| One channel missing, or the first install was interrupted | All OTA content is discarded and the bundled content is used. |
| The app itself was updated or reinstalled | OTA content installed under the old shell is discarded; the new shell's bundled content is used. |

Rollback is per channel: the other channels are not touched.

## Mobile

- Zips are downloaded natively to the cache directory and unzipped natively (`configs/capacitor-plugins/ota-unzip`), never through the WebView.
- The zips are **not checksummed**. Hashing 500MB+ on the device was the cause of crashes, so this is deliberate. A truncated download is caught instead by checking the zip's size before unzipping and its file count after; on Android the zip's central directory, which sits at the end of the file, is also read first.
- Free space is checked before downloading (all zips plus all channels unzipped, plus 10%). If free space cannot be measured the check is skipped.
- Downloaded zips are deleted after they are applied, or on failure, and leftovers are swept at launch.
- Stage, swap and reload happen in one go when the user accepts the update.

## Desktop

The shell (`main.cjs`, `preload.cjs`, `updater.cjs`, `update-io.cjs`, `ota-desktop.cjs`, `discord-rpc.cjs`, Electron, `node_modules`, the electron-builder configs) is only ever replaced by the full-binary updater. Only `dist/` is updated over the air.

**An update is applied on the next launch, not while the app is running.** Windows keeps files that are in use locked, so:

1. *While running:* each changed channel is downloaded, its SHA-256 is verified against the manifest as it streams, and it is unzipped into staging. The update screen shows each file's size and progress, then says the update will be installed on the next start and offers to restart.
2. *At the next launch, before the window loads anything:* the staged channels are swapped in. This is a few renames, so it does not slow the launch.
3. *When the title screen is reached:* the update is confirmed.

Other points:

- Content is stored in `<userData>/ota-stable` (or `ota-dev`); `main.cjs` loads `index.html` from there when a complete set is installed, otherwise from the bundled `dist/`. Saves are unaffected: they are in `localStorage`, which is shared by both locations.
- The **first** content update copies the bundled `dist/` out of the app archive once (it cannot be modified in place). Its channel versions are read from the manifest of the release the shell was built from, so only channels that actually changed are downloaded.
- If installed content fails to load before reaching the title screen, the window shows the bundled content for that run.
- If another copy of the app is running, a newly started copy does not swap, roll back or recover anything; it loads what is in place.
- Zips are unzipped with yauzl. An entry that would land outside the destination, or that is a symbolic link, fails the whole unzip.

### Full-binary updater (`updater.cjs`)

Downloads the platform's binary, verifies it against `SHA256SUMS.txt`, renames the running binary to `<name>.old` and moves the new one into its place, then relaunches. If the new one cannot be moved in, the original is put back. On Linux the downloaded AppImage is made executable before the swap. On Windows the file replaced is the exe the user launched (`PORTABLE_EXECUTABLE_FILE`), not the portable build's unpacked copy.

## Release pipeline

1. `build-android.yml` / `build-ios.yml`: compute the fingerprint, inject it into `mobile-updater.ts`, build, run `split-ota-bundle.js <platform>`.
2. `build-exe.yml` / `build-appimage.yml` / `build-macos.yml`: compute the desktop fingerprint, stage `ota-desktop.cjs` and the transpiled `ota-core.cjs` with the fingerprint injected, build. The AppImage job also runs `split-ota-bundle.js desktop`.
3. `create-release.yaml`: collects the artifacts, renames them to the names in the table above, writes `SHA256SUMS.txt` and publishes.
