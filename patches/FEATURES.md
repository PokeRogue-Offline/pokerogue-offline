# Feature → patch file index

This repo patches a fresh clone of upstream `pokerogue-src/` via anchor/regex
string surgery, using standalone Node scripts under `patches/{all,mobile,android}/node/`
(`all` = every platform, `mobile` = iOS + Android, `android` = Android only).
Apply order is defined in `scripts/apply-patches.sh` (pre-build) and
`scripts/apply-post-build-patches.sh` (post-build, targets `dist/index.html`).
Two Android manifest patches run neither script — they're invoked directly
from `.github/workflows/build-android.yml`, since `AndroidManifest.xml`
doesn't exist until the workflow's `npx cap add android` step runs.

This file maps each *feature* to every patch file that implements it, so
removing or auditing a feature means checking one list here instead of
grepping the whole `patches/` tree. Some files below are shared by multiple
unrelated features (see "Shared files, unrelated features" at the end) —
that overlap is intentional and left alone; don't read co-location as
coupling unless it's called out here.

## Cloud backup (Google Drive / Dropbox)

The most scattered feature in the repo — investigated for consolidation and
found to be genuinely spread across build stages/platforms that can't share
one script (see plan history / patch header comments for the full reasoning).
To remove or audit this feature, check all of:

- `patches/all/node/app-settings-menu.js` — owns the Backup tab (provider
  select, connect/disconnect, backup/restore, clear data) *and* the shared
  Offline-menu infrastructure both Backup and Preferences tabs depend on
  (pause-menu entry, tab-switching, `settingsTabs` injection on
  `base-settings-ui-handler.ts`, the `activateSetting()` hook, the combined
  `OfflineSettings` type/defaults/manager getter). Creates
  `src/system/offline/{backup-provider,backup-manager,google-drive-backup,dropbox-backup}.ts`.
- `patches/all/node/auto-drive-sync.js` — automatic backup upload every 5
  waves; imports `backup-manager.ts` from the patch above, must run after it.
- `patches/all/node/externalize-capacitor-imports.js` — Vite build fix that
  exists solely because `google-drive-backup.ts`/`dropbox-backup.ts` (from
  `app-settings-menu.js`) break desktop builds by importing Capacitor-only
  packages.
- `patches/android/node/android-manifest-url-scheme.js` — registers the
  custom URL scheme for Dropbox OAuth redirect; exists solely for
  `dropbox-backup.ts`'s OAuth flow on Android. Called directly from
  `build-android.yml`, not through either apply script.
- `patches/all/node/enable-touch-controls-quad-tap.js` — incidental, minor
  coupling: imports `isCapacitor()` from `backup-provider.ts` purely as a
  platform gate for an otherwise unrelated feature (see below).

## Native save import/export (mobile)

- `patches/mobile/node/native-save-io.js` — both the Android import-overlay
  fix (`isIos()` → `isNative()`) and the Capacitor export fix (native
  save/share flow for iOS + Android). Both edit `src/system/game-data.ts`
  with independent anchors; merged into one file since they're the same
  real feature (native save I/O quirks for mobile).

## Title-screen update notification

Ordered chain, same file (`src/ui/handlers/title-ui-handler.ts`) for the
first three — each documents its ordering requirement in its own header:

1. `patches/all/node/offline-banner.js` — "Unofficial Offline Client" banner
   text. Must run first; the next two anchor on text it produces.
2. `patches/all/node/update-check.js` — once-per-launch GitHub Releases
   check; creates `src/system/offline/update-check-api.ts`. Anchors on
   `offline-banner.js`'s output.
3. `patches/all/node/update-title-labels.js` — blanks the online-account
   labels on the title screen. Unrelated concern, just anchored in the same
   file after the above two.
4. `patches/all/node/update-available-screen.js` — the paginated changelog
   UI, registered as its own `UiMode`. Independent of the other three (does
   not touch `title-ui-handler.ts`); anchors on the stable upstream
   `ALERT_MODAL,` marker in `ui-mode.ts`/`ui.ts`, same pattern as
   `app-settings-menu.js` and `gacha-calendar.js`, so it can be added or
   removed without touching or depending on either of them.

## Damage / HP preview

- `patches/all/node/damage-preview.js` — all gameplay-facing logic (fight
  menu damage-range/KO preview, enemy HP% line).
- Its settings ("Damage Range", "Enemy HP %" toggles) live inside
  `app-settings-menu.js`'s Preferences tab (`settings-ui-items.ts`,
  `default-settings.ts`, etc.) — not a separate file, but a separate
  concern within that patch.

## Touch controls

Two independent behaviors, not the same feature despite both being
"touch controls" — kept separate on purpose:

- `patches/all/node/touch-overlay-idle-opacity.js` — CSS var for D-pad/
  button idle opacity; depends on the "Touch Button Opacity" setting added
  by `app-settings-menu.js`.
- `patches/all/node/enable-touch-controls-quad-tap.js` — quadruple-tap
  gesture to re-enable touch controls; depends on `backup-provider.ts`'s
  `isCapacitor()` only as a platform check (see Cloud backup above).

## AndroidManifest.xml edits

Called directly from `.github/workflows/build-android.yml` (not through
`apply-patches.sh`/`apply-post-build-patches.sh`), since the manifest is
created by the workflow's `npx cap add android` step:

- `patches/android/node/android-manifest-keyboard-fix.js` — soft-keyboard
  resize fix.
- `patches/android/node/android-manifest-url-scheme.js` — Dropbox OAuth
  URL scheme (see Cloud backup above).
- `patches/android/node/android-manifest-storage-permissions.js` —
  `WRITE_EXTERNAL_STORAGE`/`READ_EXTERNAL_STORAGE` permissions.

## Shared files, unrelated features (intentionally not consolidated)

These files are touched by multiple patches that are independent features
coincidentally landing in the same place. Merging them would reduce
clarity (you'd lose the ability to add/remove one without touching the
other), not improve it:

- `dist/index.html` (post-build): `patches/mobile/node/{notch-fix,fix-browser,canvas-scale-fix}.js`
  and `patches/android/node/android-trigger-axis-fix.js` — four unrelated
  device-quirk fixes (safe-area insets, `window.open` override, Android 16
  edge-to-edge rescale, gamepad trigger-axis shim).
- `src/ui/handlers/menu-ui-handler.ts`: `app-settings-menu.js`,
  `gacha-calendar.js`, `community-menu.js` — three independent pause-menu
  entries.
- `src/main.ts`: `patches/all/node/enable-touch-controls-quad-tap.js` and
  `patches/mobile/node/background-audio-pause.js` — two independent
  startup listeners.

## Everything else (single-file, single-feature patches)

`fix-daily-seed.js`, `fix-android-image-paths.js` — no cross-file or
cross-patch dependencies; self-contained.
