#!/usr/bin/env node
/**
 * Patch: app-settings-menu.js
 *
 * Adds an "Offline" tab to the REAL Settings screen (alongside
 * General/Display/Audio/Gamepad/Keyboard), via NavigationManager's
 * documented extension point.
 *
 * v6 of this patch. Changes from v5 (verified working):
 *   - NEW "Update Pop-Ups" row — a genuine two-option Setting (Off/On,
 *     default On), same zero-custom-code shape as "Include Current Run".
 *     Read by update-check.js's checkForOfflineUpdate() to decide whether a
 *     detected update also opens the full changelog screen automatically on
 *     first launch. The small "Update Available!" hint under the title
 *     screen's version text is unconditional - it always shows once an
 *     update is found, regardless of this setting.
 *
 * v5 of this patch. Changes from v4 (verified working):
 *   - REMOVED entirely: "Debug: List AppData Files" (row, screen, UiMode,
 *     new file) and the local "Last Played" / "Battles" info rows.
 *   - "Clear All Data" no longer locked behind being connected — wiping
 *     local data has nothing to do with Google Drive.
 *   - NEW "Include Current Run" row — a genuine two-option Setting (Off/On),
 *     NOT activatable, so it uses the base class's existing generic
 *     Left/Right-cycle-and-persist mechanism with zero custom code. Governs
 *     whether Backup Save includes sessionData keys. Locked until connected
 *     (it's meaningless otherwise).
 *   - NEW "Drive Last Played" row — read-only, shows the *Drive backup's*
 *     embedded save timestamp (not the local one), refreshed whenever the
 *     tab detects a live connection.
 *   - Locked rows are now grouped together in the row order: Connect,
 *     [Backup Save, Restore Backup, Include Current Run], Drive Last
 *     Played, Clear All Data.
 *
 * Sub-patches, applied in order:
 *
 *   1. src/enums/ui-mode.ts
 *        Append SETTINGS_OFFLINE (after ALERT_MODAL, the last entry).
 *
 *   2. src/system/offline/google-drive-backup.ts  (new file)
 *        Cross-platform (Capacitor / Electron) Drive backup helper.
 *        collectBackupPayload() now respects "Include Current Run";
 *        restoreFromBackup() no longer excludes session keys (it just
 *        writes back whatever a given backup actually contains); adds
 *        getRemoteLastPlayed(). listAppDataFiles() removed — nothing
 *        uses it now that the debug screen is gone.
 *
 *   3. src/ui/settings/offline-settings-ui-handler.ts  (new file)
 *        Extends BaseSettingsUiHandler (same base class as the real
 *        General/Display/Audio tabs) instead of BaseOptionSelectUiHandler,
 *        so it renders with the identical tab-bar + grid-row look.
 *
 *   4. src/ui/ui.ts
 *        Import OfflineSettingsUiHandler, register at the position
 *        matching UiMode.SETTINGS_OFFLINE, add to noTransitionModes.
 *
 *   5. src/ui/settings/navigation-menu.ts
 *        Append UiMode.SETTINGS_OFFLINE + a hardcoded "Offline" label to
 *        NavigationManager's `modes`/`labels` arrays — this is what actually
 *        makes it show up as a 6th tab in the real Settings screen.
 *
 *   6. src/system/settings/settings.ts
 *        Append SettingType.APP; append 10 SettingKeys entries; append 10
 *        Setting entries (grouped: 3 locked action/toggle rows, 1 read-only
 *        info row, 1 always-on action row, then 1 always-on action row +
 *        3 always-on read-only info rows — Value, Fetched, Expires — for
 *        the daily seed cache) to the shared Setting[] array, all
 *        type: APP so they only ever show up on our tab.
 *
 *   7. src/ui/settings/base-settings-ui-handler.ts
 *        Widen `settingLabels`, `optionValueLabels`, `optionCursors`, and
 *        `activateSetting` from private to protected. PURE VISIBILITY
 *        CHANGE — no other line in this file is touched. This is what lets
 *        our subclass (a) grey out / restyle a row's label and value text
 *        — including correctly restoring which option was selected on a
 *        multi-option row like "Include Current Run" — (b) update
 *        displayed text after an async action completes, and (c) add our
 *        own activatable-row cases without editing the base class's switch
 *        statement directly.
 *
 *   8. src/ui/settings/settings-ui-handler.ts
 *        Adds a show() override to the General tab (always the entry point
 *        when Settings is opened) that fires offlineBackup.tryRestoreSession()
 *        fire-and-forget. Prewarms the connection state so that if/when the
 *        player tabs over to Offline, the row already reflects "Connected"
 *        instead of a "Checking connection…" flash — all handler instances
 *        exist from boot (Ui.setup() constructs and calls setup() on every
 *        registered handler up front), so updating the Offline tab's state
 *        from here is safe even though it isn't the active tab. The Offline
 *        tab's own show() still does the same check independently, so this
 *        is purely a latency optimization, not a correctness dependency.
 *
 * NOTE ON TESTING: all sub-patches have been checked against a fresh clone
 * of pagefaultgames/pokerogue and the anchors are confirmed present at the
 * time this was written. The new UI handler's runtime behavior (reaching
 * into optionValueLabels/settingLabels/optionCursors after construction,
 * the activateSetting override, the UiMode.CONFIRM delay/message flow) has
 * NOT been verified in an actual build.
 */

const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: Could not find ${filePath}`);
    console.error("Make sure this script is run from the repo root and all submodules are initialised.");
    process.exit(1);
  }
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`  Written: ${filePath}`);
}

function requireAnchor(src, anchor, label) {
  if (!src.includes(anchor)) {
    console.error(`ERROR: Could not find anchor for "${label}".`);
    console.error("The upstream file may have changed. Manual inspection required.");
    process.exit(1);
  }
}

// This patch script lives at patches/all/node/app-settings-menu.js in the
// pkr-offline repo. The new source files it writes are checked into this
// same repo (under new-files/) so this script and its payload stay together.
const NEW_FILES_DIR = path.join(__dirname, "..", "..", "..", "new-files");

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1: src/enums/ui-mode.ts  →  append SETTINGS_OFFLINE
// ─────────────────────────────────────────────────────────────────────────────

const UI_MODE_PATH = path.join("pokerogue-src", "src", "enums", "ui-mode.ts");
let uiModeSrc = readFile(UI_MODE_PATH);

if (uiModeSrc.includes("SETTINGS_OFFLINE")) {
  console.log("SKIP ui-mode.ts — SETTINGS_OFFLINE already present");
} else {
  const ANCHOR = "ALERT_MODAL,";
  requireAnchor(uiModeSrc, ANCHOR, "ALERT_MODAL in ui-mode.ts");
  // Must start with "SETTINGS" — index.css shows the touch-controls F/R
  // (prev/next tab) buttons via `[data-ui-mode^="SETTINGS"]`, matched against
  // this enum key's string name (ui.ts sets `dataset.uiMode = UiMode[mode]`).
  // Naming this APP_SETTINGS (as earlier versions of this patch did) makes
  // those buttons vanish on the Offline tab since the prefix no longer matches.
  uiModeSrc = uiModeSrc.replace(ANCHOR, `${ANCHOR}\n  SETTINGS_OFFLINE,`);
  writeFile(UI_MODE_PATH, uiModeSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/system/offline/google-drive-backup.ts  (new file)
// ─────────────────────────────────────────────────────────────────────────────

const BACKUP_MODULE_PATH = path.join("pokerogue-src", "src", "system", "offline", "google-drive-backup.ts");

if (fs.existsSync(BACKUP_MODULE_PATH)) {
  console.log("SKIP google-drive-backup.ts — already exists");
} else {
  const src = fs.readFileSync(path.join(NEW_FILES_DIR, "src", "system", "offline", "google-drive-backup.ts"), "utf8");
  writeFile(BACKUP_MODULE_PATH, src);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 3: src/ui/settings/offline-settings-ui-handler.ts  (new file)
// ─────────────────────────────────────────────────────────────────────────────

const HANDLER_PATH = path.join("pokerogue-src", "src", "ui", "settings", "offline-settings-ui-handler.ts");

if (fs.existsSync(HANDLER_PATH)) {
  console.log("SKIP offline-settings-ui-handler.ts — already exists");
} else {
  const src = fs.readFileSync(
    path.join(NEW_FILES_DIR, "src", "ui", "settings", "offline-settings-ui-handler.ts"),
    "utf8",
  );
  writeFile(HANDLER_PATH, src);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 4: src/ui/ui.ts  →  import + register + noTransitionModes
// ─────────────────────────────────────────────────────────────────────────────

const UI_PATH = path.join("pokerogue-src", "src", "ui", "ui.ts");
let uiSrc = readFile(UI_PATH);

if (uiSrc.includes("OfflineSettingsUiHandler")) {
  console.log("SKIP ui.ts — OfflineSettingsUiHandler already present");
} else {
  const IMPORT_ANCHOR = `import { AlertModalUiHandler } from "#ui/alert-modal-ui-handler";`;
  requireAnchor(uiSrc, IMPORT_ANCHOR, "AlertModalUiHandler import in ui.ts");
  uiSrc = uiSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\nimport { OfflineSettingsUiHandler } from "#ui/offline-settings-ui-handler";`,
  );

  const HANDLER_ANCHOR = `new AlertModalUiHandler(),`;
  requireAnchor(uiSrc, HANDLER_ANCHOR, "new AlertModalUiHandler() in ui.ts");
  uiSrc = uiSrc.replace(HANDLER_ANCHOR, `${HANDLER_ANCHOR}\n      new OfflineSettingsUiHandler(),`);

  const NO_TRANSITION_ANCHOR = `UiMode.ALERT_MODAL,`;
  requireAnchor(uiSrc, NO_TRANSITION_ANCHOR, "UiMode.ALERT_MODAL in noTransitionModes");
  uiSrc = uiSrc.replace(NO_TRANSITION_ANCHOR, `${NO_TRANSITION_ANCHOR}\n  UiMode.SETTINGS_OFFLINE,`);

  writeFile(UI_PATH, uiSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 5: src/ui/settings/navigation-menu.ts  →  register the 6th tab
// ─────────────────────────────────────────────────────────────────────────────

const NAV_PATH = path.join("pokerogue-src", "src", "ui", "settings", "navigation-menu.ts");
let navSrc = readFile(NAV_PATH);

if (navSrc.includes("UiMode.SETTINGS_OFFLINE")) {
  console.log("SKIP navigation-menu.ts — SETTINGS_OFFLINE tab already present");
} else {
  const MODES_ANCHOR = `UiMode.SETTINGS_KEYBOARD,\n    ];`;
  requireAnchor(navSrc, MODES_ANCHOR, "modes array in navigation-menu.ts");
  navSrc = navSrc.replace(MODES_ANCHOR, `UiMode.SETTINGS_KEYBOARD,\n      UiMode.SETTINGS_OFFLINE,\n    ];`);

  const LABELS_ANCHOR = `i18next.t("settings:keyboard"),\n    ];`;
  requireAnchor(navSrc, LABELS_ANCHOR, "labels array in navigation-menu.ts");
  // Hardcoded, deliberately not routed through i18next — offline-client-only feature.
  navSrc = navSrc.replace(LABELS_ANCHOR, `i18next.t("settings:keyboard"),\n      "Offline",\n    ];`);

  writeFile(NAV_PATH, navSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 6: src/system/settings/settings.ts  →  SettingType, SettingKeys, Setting[]
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join("pokerogue-src", "src", "system", "settings", "settings.ts");
let settingsSrc = readFile(SETTINGS_PATH);

if (settingsSrc.includes("SettingType.APP")) {
  console.log("SKIP settings.ts — SettingType.APP already present");
} else {
  // 6a. SettingType enum — append APP.
  const TYPE_ANCHOR = `export enum SettingType {\n  GENERAL,\n  DISPLAY,\n  AUDIO,\n}`;
  requireAnchor(settingsSrc, TYPE_ANCHOR, "SettingType enum in settings.ts");
  settingsSrc = settingsSrc.replace(
    TYPE_ANCHOR,
    `export enum SettingType {\n  GENERAL,\n  DISPLAY,\n  AUDIO,\n  APP,\n}`,
  );

  // 6b. SettingKeys — append 6 new keys.
  const KEYS_ANCHOR = `Prefer_Baton_Pass: "PREFER_BATON_PASS",\n};`;
  requireAnchor(settingsSrc, KEYS_ANCHOR, "SettingKeys object in settings.ts");
  settingsSrc = settingsSrc.replace(
    KEYS_ANCHOR,
    `Prefer_Baton_Pass: "PREFER_BATON_PASS",
  Offline_Google_Connect: "OFFLINE_GOOGLE_CONNECT",
  Offline_Backup_Save: "OFFLINE_BACKUP_SAVE",
  Offline_Restore_Backup: "OFFLINE_RESTORE_BACKUP",
  Offline_Include_Current_Run: "OFFLINE_INCLUDE_CURRENT_RUN",
  Offline_Drive_Last_Played: "OFFLINE_DRIVE_LAST_PLAYED",
  Offline_Clear_Data: "OFFLINE_CLEAR_DATA",
  Offline_Force_Daily_Seed: "OFFLINE_FORCE_DAILY_SEED",
  Offline_Daily_Seed_Value: "OFFLINE_DAILY_SEED_VALUE",
  Offline_Daily_Seed_Fetched: "OFFLINE_DAILY_SEED_FETCHED",
  Offline_Daily_Seed_Expires: "OFFLINE_DAILY_SEED_EXPIRES",
  Offline_Update_Pop_Ups: "OFFLINE_UPDATE_POP_UPS",
};`,
  );

  // 6c. Setting[] array — append 6 new rows, locked ones grouped together.
  const SETTING_ANCHOR = `  {
    key: SettingKeys.Prefer_Baton_Pass,
    label: i18next.t("settings:preferBatonPass"),
    options: OFF_ON,
    default: 1,
    type: SettingType.DISPLAY,
  },
];`;
  requireAnchor(settingsSrc, SETTING_ANCHOR, "last Setting[] entry in settings.ts");
  settingsSrc = settingsSrc.replace(
    SETTING_ANCHOR,
    `  {
    key: SettingKeys.Prefer_Baton_Pass,
    label: i18next.t("settings:preferBatonPass"),
    options: OFF_ON,
    default: 1,
    type: SettingType.DISPLAY,
  },
  {
    key: SettingKeys.Offline_Google_Connect,
    label: "Connect Google Account",
    options: [{ value: "0", label: "Not Connected" }],
    default: 0,
    type: SettingType.APP,
    activatable: true,
  },
  {
    key: SettingKeys.Offline_Backup_Save,
    label: "Backup Save",
    options: [{ value: "0", label: "Google Drive" }],
    default: 0,
    type: SettingType.APP,
    activatable: true,
  },
  {
    key: SettingKeys.Offline_Restore_Backup,
    label: "Restore Backup",
    options: [{ value: "0", label: "Restore" }],
    default: 0,
    type: SettingType.APP,
    activatable: true,
  },
  {
    key: SettingKeys.Offline_Include_Current_Run,
    label: "Include Current Run",
    options: [
      { value: "0", label: "Off" },
      { value: "1", label: "On" },
    ],
    default: 0,
    type: SettingType.APP,
  },
  {
    key: SettingKeys.Offline_Drive_Last_Played,
    label: "Drive Last Played",
    options: [{ value: "0", label: "—" }],
    default: 0,
    type: SettingType.APP,
  },
  {
    key: SettingKeys.Offline_Clear_Data,
    label: "Clear All Data",
    options: [{ value: "0", label: "Clear" }],
    default: 0,
    type: SettingType.APP,
    activatable: true,
  },
  {
    key: SettingKeys.Offline_Force_Daily_Seed,
    label: "Force Daily Seed",
    options: [{ value: "0", label: "Update" }],
    default: 0,
    type: SettingType.APP,
    activatable: true,
  },
  {
    key: SettingKeys.Offline_Daily_Seed_Value,
    label: "Daily Seed Value",
    options: [{ value: "0", label: "None" }],
    default: 0,
    type: SettingType.APP,
  },
  {
    key: SettingKeys.Offline_Daily_Seed_Fetched,
    label: "Daily Seed Fetched",
    options: [{ value: "0", label: "—" }],
    default: 0,
    type: SettingType.APP,
  },
  {
    key: SettingKeys.Offline_Daily_Seed_Expires,
    label: "Daily Seed Expires",
    options: [{ value: "0", label: "—" }],
    default: 0,
    type: SettingType.APP,
  },
  {
    key: SettingKeys.Offline_Update_Pop_Ups,
    label: "Update Pop-Ups",
    options: [
      { value: "0", label: "Off" },
      { value: "1", label: "On" },
    ],
    default: 1,
    type: SettingType.APP,
  },
];`,
  );

  writeFile(SETTINGS_PATH, settingsSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 7: src/ui/settings/base-settings-ui-handler.ts  →  widen visibility
// ─────────────────────────────────────────────────────────────────────────────

const BASE_HANDLER_PATH = path.join("pokerogue-src", "src", "ui", "settings", "base-settings-ui-handler.ts");
let baseHandlerSrc = readFile(BASE_HANDLER_PATH);

if (baseHandlerSrc.includes("protected optionValueLabels")) {
  console.log("SKIP base-settings-ui-handler.ts — already widened");
} else {
  const LABELS_FIELD_ANCHOR = `private settingLabels: Phaser.GameObjects.Text[];`;
  requireAnchor(baseHandlerSrc, LABELS_FIELD_ANCHOR, "settingLabels field in base-settings-ui-handler.ts");
  baseHandlerSrc = baseHandlerSrc.replace(LABELS_FIELD_ANCHOR, `protected settingLabels: Phaser.GameObjects.Text[];`);

  const VALUES_FIELD_ANCHOR = `private optionValueLabels: Phaser.GameObjects.Text[][];`;
  requireAnchor(baseHandlerSrc, VALUES_FIELD_ANCHOR, "optionValueLabels field in base-settings-ui-handler.ts");
  baseHandlerSrc = baseHandlerSrc.replace(
    VALUES_FIELD_ANCHOR,
    `protected optionValueLabels: Phaser.GameObjects.Text[][];`,
  );

  const CURSORS_FIELD_ANCHOR = `private optionCursors: number[];`;
  requireAnchor(baseHandlerSrc, CURSORS_FIELD_ANCHOR, "optionCursors field in base-settings-ui-handler.ts");
  baseHandlerSrc = baseHandlerSrc.replace(CURSORS_FIELD_ANCHOR, `protected optionCursors: number[];`);

  const METHOD_ANCHOR = `private activateSetting(setting: Setting): boolean {`;
  requireAnchor(baseHandlerSrc, METHOD_ANCHOR, "activateSetting method in base-settings-ui-handler.ts");
  baseHandlerSrc = baseHandlerSrc.replace(METHOD_ANCHOR, `protected activateSetting(setting: Setting): boolean {`);

  writeFile(BASE_HANDLER_PATH, baseHandlerSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 8: src/ui/settings/settings-ui-handler.ts  →  prewarm connection on open
// ─────────────────────────────────────────────────────────────────────────────

const GENERAL_TAB_PATH = path.join("pokerogue-src", "src", "ui", "settings", "settings-ui-handler.ts");
let generalTabSrc = readFile(GENERAL_TAB_PATH);

if (generalTabSrc.includes("app-settings-menu: prewarm")) {
  console.log("SKIP settings-ui-handler.ts — prewarm already present");
} else {
  const IMPORT_ANCHOR = `import { SettingType } from "#system/settings";`;
  requireAnchor(generalTabSrc, IMPORT_ANCHOR, "SettingType import in settings-ui-handler.ts");
  generalTabSrc = generalTabSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\nimport * as offlineBackup from "#system/offline/google-drive-backup";`,
  );

  const CLASS_END_ANCHOR = `    this.title = "General";\n    this.localStorageKey = "settings";\n  }\n}`;
  requireAnchor(generalTabSrc, CLASS_END_ANCHOR, "constructor/class end in settings-ui-handler.ts");
  const CLASS_END_REPLACEMENT =
    `    this.title = "General";\n` +
    `    this.localStorageKey = "settings";\n` +
    `  }\n\n` +
    `  // app-settings-menu: prewarm the Google Drive connection state whenever\n` +
    `  // the Settings screen is opened (General is always the entry tab), so\n` +
    `  // the Offline tab's row already reflects the resolved state instead of\n` +
    `  // a "Checking…" flash if/when the player tabs over to it. No-op if\n` +
    `  // already signed in this session.\n` +
    `  override show(args: any[]): boolean {\n` +
    `    const result = super.show(args);\n` +
    `    if (!offlineBackup.isSignedIn()) {\n` +
    `      offlineBackup.tryRestoreSession().catch(err => {\n` +
    `        console.warn("Silent session restore failed:", err);\n` +
    `      });\n` +
    `    }\n` +
    `    return result;\n` +
    `  }\n` +
    `}`;
  generalTabSrc = generalTabSrc.replace(CLASS_END_ANCHOR, CLASS_END_REPLACEMENT);

  writeFile(GENERAL_TAB_PATH, generalTabSrc);
}

console.log("\napp-settings-menu patch applied successfully.");
