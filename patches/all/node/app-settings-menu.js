#!/usr/bin/env node
/**
 * Patch: app-settings-menu.js
 *
 * Adds an "Offline" entry to the pause menu, opening a standalone mini
 * settings screen with two sub-tabs: "Backup" (cloud backup/sync) and
 * "Preferences" (daily-seed cache, Update Pop-Ups, Damage Range, Enemy HP%,
 * Touch Button Opacity).
 *
 * v11 of this patch. Changes from v10 — moved out of the real Settings
 * screen's tab bar:
 *   - v10 added "Offline" as a 6th tab alongside General/Display/Audio/
 *     Gamepad/Keyboard, registered in BaseSettingsUiHandler's `settingsTabs`
 *     array. Manual testing on a real build showed this breaks the tab bar:
 *     `TabMenu` (src/ui/containers/tab-menu.ts) lays out labels in a
 *     hardcoded-320px header with no wrapping/clipping/scroll support at
 *     all — it was clearly tuned for exactly 5 short English labels, and a
 *     6th tab collides with the R/F tab-cycle hint icons at the header's
 *     right edge (or gets partly hidden behind them, depending on the tab).
 *   - Fix: Offline is now reached via its OWN pause-menu entry (mirroring
 *     gacha-calendar.js's existing MenuOptions/UiMode pattern exactly),
 *     opening a small mini-Settings screen with its own 2-entry TabMenu
 *     (see new-files/src/ui/settings/offline-tabs.ts) — completely
 *     independent of the real 5-tab bar, so there's no overflow risk.
 *   - BaseSettingsUiHandler's `settingsTabs` field used to be a hardcoded
 *     array in the class body, shared by every subclass. It's now a
 *     constructor parameter (default value = the same 5 real tabs, so
 *     General/Display/Audio's existing `super(category, uiItems)` calls are
 *     unaffected) — the two new Offline handlers pass their own small
 *     2-entry array instead.
 *   - The previous single OfflineSettingsUiHandler (16 rows) is split into
 *     OfflineBackupUiHandler (8 rows: provider/connect/disconnect/backup/
 *     restore/include-current-run/last-played/clear-data) and
 *     OfflinePreferencesUiHandler (8 rows: force-daily-seed + the 3
 *     read-only daily-seed info rows + Update Pop-Ups/Damage Range/Enemy
 *     HP%/Touch Button Opacity) — roughly even split, mirroring how the
 *     real Settings screen itself is split into multiple tabs rather than
 *     one long list.
 *   - The general-settings-ui-handler.ts "prewarm connection on open" sub-
 *     patch from v10 is REMOVED — it prewarmed the backup connection state
 *     when the (real) General settings tab opened, reasoning that Offline
 *     was a sibling tab the player might switch to. That's no longer true
 *     (Offline is a separate pause-menu screen now), and it was redundant
 *     anyway: OfflineBackupUiHandler's own show() already does the same
 *     silent tryRestoreSession() check on-demand.
 *   - gacha-calendar.js's own pause-menu label-rendering patch (same
 *     `label:` line in menu-ui-handler.ts's option-building `.map()`) is
 *     updated separately to chain onto the ternary this patch introduces —
 *     apply-patches.sh always runs this patch before gacha-calendar.js, so
 *     by the time gacha-calendar.js's sub-patch runs, the line is no longer
 *     in its pristine (single i18next-only) shape.
 *   - Sub-patches 1 (ui-mode.ts), 2 (backup-*.ts new files), 4 (ui.ts
 *     import/register/noTransitionModes — now for two handlers/modes), and
 *     the ui-inputs.ts whitelist (also two handlers now) keep the same
 *     shape/anchors as v10, just duplicated for the two new UiModes.
 *
 * Sub-patches, applied in order:
 *
 *   1. src/enums/ui-mode.ts
 *        Append SETTINGS_OFFLINE_BACKUP, SETTINGS_OFFLINE_PREFERENCES
 *        (after ALERT_MODAL, the last entry). Both names must start with
 *        "SETTINGS" — index.css shows the touch-controls F/R (prev/next
 *        tab) buttons via `[data-ui-mode^="SETTINGS"]`.
 *
 *   2. src/system/offline/{backup-provider,backup-manager,
 *      google-drive-backup,dropbox-backup}.ts  (new files, plus paired tests)
 *        backup-provider.ts defines the shared BackupProvider interface and
 *        the pure isSafeToAutoUpload() anti-overwrite check. google-drive-
 *        backup.ts and dropbox-backup.ts each implement it for their
 *        respective cloud backend. backup-manager.ts is the single module
 *        the UI (sub-patch 3) and the auto-sync patch
 *        (patches/all/node/auto-drive-sync.js) actually call.
 *
 *   3. src/ui/settings/offline-tabs.ts, offline-backup-ui-handler.ts,
 *      offline-preferences-ui-handler.ts  (new files)
 *        offline-tabs.ts exports the shared 2-entry OFFLINE_TABS array both
 *        handlers pass as their `settingsTabs` constructor argument.
 *
 *   4. src/ui/ui.ts
 *        Import both handlers, register at the positions matching the two
 *        new UiModes, add both to noTransitionModes.
 *
 *   5. src/ui/settings/base-settings-ui-handler.ts  →  settingsTabs injectable
 *        Turn the hardcoded `settingsTabs` field into a constructor
 *        parameter (default: the same 5 real tabs) so a subclass can pass
 *        its own small tab set instead of sharing the real Settings
 *        screen's 5-tab bar.
 *
 *   6. src/@types/settings.ts, src/system/settings/default-settings.ts,
 *      src/system/settings/settings-manager.ts, src/ui/settings/settings-ui-items.ts,
 *      src/battle-scene.ts
 *        Add the "offline" settings category end-to-end: the OfflineSettings
 *        type (16 fields covering backup state, daily-seed cache display,
 *        the Update Pop-Ups/Damage Range/Enemy HP%/Touch Button Opacity
 *        toggles), its defaults, a manager getter + localStorage load/merge,
 *        the UI row definitions (split into offlineBackupUiItems /
 *        offlinePreferencesUiItems), and a live-apply case for Touch Button
 *        Opacity's CSS var.
 *
 *   7. src/ui/settings/base-settings-ui-handler.ts  →  widen + add hook
 *        Widen `settingLabels`, `optionValueLabels`, and `optionCursors`
 *        from private to protected (pure visibility changes — lets our
 *        subclasses grey out / restyle rows and update displayed text after
 *        an async action completes). ADD a new `activateSetting()`
 *        extension point (base: no-op) and wire it into the Button.ACTION
 *        case of processInput() — upstream's rewritten settings UI has no
 *        concept of action rows at all, every other tab's rows just cycle
 *        values.
 *
 *   8. src/ui/handlers/menu-ui-handler.ts
 *        Add MenuOptions.OFFLINE (next to GAME_SETTINGS), a label-map
 *        special-case (hardcoded "Offline" — offline-client-only feature,
 *        not in real locale files, same reasoning as "Gacha Calendar"), and
 *        a switch-case opening UiMode.SETTINGS_OFFLINE_BACKUP (the landing
 *        sub-tab) — same pattern as GAME_SETTINGS (no revertMode first, so
 *        Cancel/Back returns to the pause menu). Not added to any exclusion
 *        list — always available, same as Game Settings/Achievements/Stats.
 *
 *   9. src/ui-inputs.ts
 *        Import both handlers and append them to the `whitelist` array in
 *        buttonCycleOption() — without this, Button.CYCLE_SHINY/CYCLE_FORM
 *        (the tab-switch keys) are silently dropped while an Offline screen
 *        is active.
 *
 * NOTE ON TESTING: all sub-patches have been checked against a fresh clone
 * of pagefaultgames/pokerogue (beta branch) and the anchors are confirmed
 * present at the time this was written, and the resulting tree has been
 * confirmed to build (`pnpm build --mode app`). The new UI handlers' runtime
 * behavior (the 2-tab mini-Settings screen's actual layout/navigation, the
 * activateSetting override, the UiMode.CONFIRM delay/message flow) has NOT
 * been verified in an actual running build — the tab-overflow issue that
 * prompted this rewrite was only found by shipping v10 and manually testing.
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
// Sub-patch 1: src/enums/ui-mode.ts  →  append the two new UiModes
// ─────────────────────────────────────────────────────────────────────────────

const UI_MODE_PATH = path.join("pokerogue-src", "src", "enums", "ui-mode.ts");
let uiModeSrc = readFile(UI_MODE_PATH);

if (uiModeSrc.includes("SETTINGS_OFFLINE_BACKUP")) {
  console.log("SKIP ui-mode.ts — SETTINGS_OFFLINE_BACKUP already present");
} else {
  const ANCHOR = "ALERT_MODAL,";
  requireAnchor(uiModeSrc, ANCHOR, "ALERT_MODAL in ui-mode.ts");
  uiModeSrc = uiModeSrc.replace(ANCHOR, `${ANCHOR}\n  SETTINGS_OFFLINE_BACKUP,\n  SETTINGS_OFFLINE_PREFERENCES,`);
  writeFile(UI_MODE_PATH, uiModeSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/system/offline/{backup-provider,backup-manager,
//   google-drive-backup,dropbox-backup}.ts  (new files, plus paired tests)
// ─────────────────────────────────────────────────────────────────────────────

const BACKUP_MODULE_NAMES = ["backup-provider", "backup-manager", "google-drive-backup", "dropbox-backup"];

for (const moduleName of BACKUP_MODULE_NAMES) {
  const modulePath = path.join("pokerogue-src", "src", "system", "offline", `${moduleName}.ts`);
  if (fs.existsSync(modulePath)) {
    console.log(`SKIP ${moduleName}.ts — already exists`);
  } else {
    const src = fs.readFileSync(path.join(NEW_FILES_DIR, "src", "system", "offline", `${moduleName}.ts`), "utf8");
    writeFile(modulePath, src);
  }

  const testPath = path.join("pokerogue-src", "test", "tests", "system", "offline", `${moduleName}.test.ts`);
  const testSrcPath = path.join(NEW_FILES_DIR, "test", "tests", "system", "offline", `${moduleName}.test.ts`);
  if (fs.existsSync(testPath)) {
    console.log(`SKIP ${moduleName}.test.ts — already exists`);
  } else if (!fs.existsSync(testSrcPath)) {
    // google-drive-backup.ts is the only one of these four with no dedicated
    // test file — its one testable pure function (isSafeToAutoUpload) moved
    // to backup-provider.ts, which is now shared/tested there instead.
    console.log(`SKIP ${moduleName}.test.ts — no test file to copy`);
  } else {
    const testSrc = fs.readFileSync(testSrcPath, "utf8");
    writeFile(testPath, testSrc);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 3: src/ui/settings/{offline-tabs,offline-backup-ui-handler,
//   offline-preferences-ui-handler}.ts  (new files)
// ─────────────────────────────────────────────────────────────────────────────

const OFFLINE_UI_FILE_NAMES = ["offline-tabs", "offline-backup-ui-handler", "offline-preferences-ui-handler"];

for (const fileName of OFFLINE_UI_FILE_NAMES) {
  const filePath = path.join("pokerogue-src", "src", "ui", "settings", `${fileName}.ts`);
  if (fs.existsSync(filePath)) {
    console.log(`SKIP ${fileName}.ts — already exists`);
  } else {
    const src = fs.readFileSync(path.join(NEW_FILES_DIR, "src", "ui", "settings", `${fileName}.ts`), "utf8");
    writeFile(filePath, src);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 4: src/ui/ui.ts  →  import + register + noTransitionModes
// ─────────────────────────────────────────────────────────────────────────────

const UI_PATH = path.join("pokerogue-src", "src", "ui", "ui.ts");
let uiSrc = readFile(UI_PATH);

if (uiSrc.includes("OfflineBackupUiHandler")) {
  console.log("SKIP ui.ts — OfflineBackupUiHandler already present");
} else {
  const IMPORT_ANCHOR = `import { AlertModalUiHandler } from "#ui/alert-modal-ui-handler";`;
  requireAnchor(uiSrc, IMPORT_ANCHOR, "AlertModalUiHandler import in ui.ts");
  uiSrc = uiSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\n` +
      `import { OfflineBackupUiHandler } from "#ui/offline-backup-ui-handler";\n` +
      `import { OfflinePreferencesUiHandler } from "#ui/offline-preferences-ui-handler";`,
  );

  const HANDLER_ANCHOR = `new AlertModalUiHandler(),`;
  requireAnchor(uiSrc, HANDLER_ANCHOR, "new AlertModalUiHandler() in ui.ts");
  uiSrc = uiSrc.replace(
    HANDLER_ANCHOR,
    `${HANDLER_ANCHOR}\n      new OfflineBackupUiHandler(),\n      new OfflinePreferencesUiHandler(),`,
  );

  const NO_TRANSITION_ANCHOR = `UiMode.ALERT_MODAL,`;
  requireAnchor(uiSrc, NO_TRANSITION_ANCHOR, "UiMode.ALERT_MODAL in noTransitionModes");
  uiSrc = uiSrc.replace(
    NO_TRANSITION_ANCHOR,
    `${NO_TRANSITION_ANCHOR}\n  UiMode.SETTINGS_OFFLINE_BACKUP,\n  UiMode.SETTINGS_OFFLINE_PREFERENCES,`,
  );

  writeFile(UI_PATH, uiSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 5+7: src/ui/settings/base-settings-ui-handler.ts
//   → settingsTabs injectable, widen 3 fields to protected, add activateSetting()
// ─────────────────────────────────────────────────────────────────────────────

const BASE_HANDLER_PATH = path.join("pokerogue-src", "src", "ui", "settings", "base-settings-ui-handler.ts");
let baseHandlerSrc = readFile(BASE_HANDLER_PATH);

if (baseHandlerSrc.includes("protected activateSetting")) {
  console.log("SKIP base-settings-ui-handler.ts — already patched");
} else {
  // 5a. Field: drop the hardcoded array, keep just the type.
  const TABS_FIELD_ANCHOR =
    `  protected tabMenu: TabMenu;\n` +
    `  protected readonly settingsTabs = [\n` +
    `    { mode: UiMode.SETTINGS_GENERAL, labelKey: "settings:general" },\n` +
    `    { mode: UiMode.SETTINGS_DISPLAY, labelKey: "settings:display" },\n` +
    `    { mode: UiMode.SETTINGS_AUDIO, labelKey: "settings:audio" },\n` +
    `    { mode: UiMode.SETTINGS_GAMEPAD, labelKey: "settings:gamepad" },\n` +
    `    { mode: UiMode.SETTINGS_KEYBOARD, labelKey: "settings:keyboard" },\n` +
    `  ];`;
  requireAnchor(baseHandlerSrc, TABS_FIELD_ANCHOR, "settingsTabs field in base-settings-ui-handler.ts");
  baseHandlerSrc = baseHandlerSrc.replace(
    TABS_FIELD_ANCHOR,
    `  protected tabMenu: TabMenu;\n` + `  protected readonly settingsTabs: { mode: UiMode; labelKey: string }[];`,
  );

  // 5b. Constructor: accept settingsTabs as an optional 3rd param, defaulting
  // to the same 5 real tabs (so every existing `super(category, uiItems)`
  // call in General/Display/Audio's handlers is unaffected).
  const CTOR_ANCHOR =
    `  constructor(category: SettingsCategory, uiItems: SettingsUiItem[]) {\n` +
    `    super();\n` +
    `\n` +
    `    this.category = category;\n` +
    `\n` +
    `    if (hasTouchscreen()) {`;
  requireAnchor(baseHandlerSrc, CTOR_ANCHOR, "constructor in base-settings-ui-handler.ts");
  baseHandlerSrc = baseHandlerSrc.replace(
    CTOR_ANCHOR,
    `  constructor(\n` +
      `    category: SettingsCategory,\n` +
      `    uiItems: SettingsUiItem[],\n` +
      `    settingsTabs: { mode: UiMode; labelKey: string }[] = [\n` +
      `      { mode: UiMode.SETTINGS_GENERAL, labelKey: "settings:general" },\n` +
      `      { mode: UiMode.SETTINGS_DISPLAY, labelKey: "settings:display" },\n` +
      `      { mode: UiMode.SETTINGS_AUDIO, labelKey: "settings:audio" },\n` +
      `      { mode: UiMode.SETTINGS_GAMEPAD, labelKey: "settings:gamepad" },\n` +
      `      { mode: UiMode.SETTINGS_KEYBOARD, labelKey: "settings:keyboard" },\n` +
      `    ],\n` +
      `  ) {\n` +
      `    super();\n` +
      `\n` +
      `    this.category = category;\n` +
      `    this.settingsTabs = settingsTabs;\n` +
      `\n` +
      `    if (hasTouchscreen()) {`,
  );

  // 7a. Widen settingLabels/optionValueLabels/optionCursors to protected.
  const FIELDS_ANCHOR =
    `  private optionCursors: number[];\n` +
    `\n` +
    `  private settingLabels: Phaser.GameObjects.Text[];\n` +
    `  private optionValueLabels: Phaser.GameObjects.Text[][];`;
  requireAnchor(baseHandlerSrc, FIELDS_ANCHOR, "optionCursors/settingLabels/optionValueLabels fields");
  baseHandlerSrc = baseHandlerSrc.replace(
    FIELDS_ANCHOR,
    `  protected optionCursors: number[];\n` +
      `\n` +
      `  protected settingLabels: Phaser.GameObjects.Text[];\n` +
      `  protected optionValueLabels: Phaser.GameObjects.Text[][];`,
  );

  // 7b. Wire Button.ACTION to the new activateSetting() hook.
  const ACTION_ANCHOR = `        case Button.ACTION:\n          break;\n      }`;
  requireAnchor(baseHandlerSrc, ACTION_ANCHOR, "Button.ACTION case in processInput()");
  baseHandlerSrc = baseHandlerSrc.replace(
    ACTION_ANCHOR,
    `        case Button.ACTION:\n          success = this.activateSetting(this.uiItems[cursor]);\n          break;\n      }`,
  );

  // 7c. Add the activateSetting() extension point itself, right before
  // handleSaveSetting() (a logically adjacent spot).
  const SAVE_SETTING_ANCHOR = `  protected handleSaveSetting<V = any>(uiItem: SettingsUiItem, newValue: V): void {`;
  requireAnchor(baseHandlerSrc, SAVE_SETTING_ANCHOR, "handleSaveSetting method in base-settings-ui-handler.ts");
  baseHandlerSrc = baseHandlerSrc.replace(
    SAVE_SETTING_ANCHOR,
    `  /**\n` +
      `   * app-settings-menu: extension point for settings tabs with "action" rows\n` +
      `   * (e.g. the Offline screens' Connect/Backup/Restore buttons) that need to\n` +
      `   * run custom logic on Button.ACTION rather than just cycling an option\n` +
      `   * value. Base implementation is a no-op so every other tab's behavior\n` +
      `   * (Button.ACTION does nothing) is unchanged.\n` +
      `   */\n` +
      `  protected activateSetting(_uiItem: SettingsUiItem): boolean {\n` +
      `    return false;\n` +
      `  }\n` +
      `\n` +
      `${SAVE_SETTING_ANCHOR}`,
  );

  writeFile(BASE_HANDLER_PATH, baseHandlerSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 6: the "offline" settings category, end-to-end
// ─────────────────────────────────────────────────────────────────────────────

// 6a. src/@types/settings.ts
const TYPES_PATH = path.join("pokerogue-src", "src", "@types", "settings.ts");
let typesSrc = readFile(TYPES_PATH);

if (typesSrc.includes("OfflineSettings")) {
  console.log("SKIP @types/settings.ts — OfflineSettings already present");
} else {
  const USER_FACING_ANCHOR =
    `export interface UserFacingSettings {\n` +
    `  audio: AudioSettings;\n` +
    `  display: DisplaySettings;\n` +
    `  gamepad: GamepadSettings;\n` +
    `  general: GeneralSettings;\n` +
    `}`;
  requireAnchor(typesSrc, USER_FACING_ANCHOR, "UserFacingSettings interface in @types/settings.ts");
  typesSrc = typesSrc.replace(
    USER_FACING_ANCHOR,
    `export interface UserFacingSettings {\n` +
      `  audio: AudioSettings;\n` +
      `  display: DisplaySettings;\n` +
      `  gamepad: GamepadSettings;\n` +
      `  general: GeneralSettings;\n` +
      `  offline: OfflineSettings;\n` +
      `}`,
  );

  const ANY_KEY_ANCHOR = `export type AnySettingKey = GeneralSettingsKey | DisplaySettingsKey | AudioSettingsKey | GamepadSettingsKey;`;
  requireAnchor(typesSrc, ANY_KEY_ANCHOR, "AnySettingKey type in @types/settings.ts");
  typesSrc = typesSrc.replace(ANY_KEY_ANCHOR, `${ANY_KEY_ANCHOR.replace(";", "")} | OfflineSettingsKey;`);

  const LAST_LINE_ANCHOR = `export type GamepadSettingsKey = keyof GamepadSettings;`;
  requireAnchor(typesSrc, LAST_LINE_ANCHOR, "GamepadSettingsKey type (end of file) in @types/settings.ts");
  typesSrc = typesSrc.replace(
    LAST_LINE_ANCHOR,
    `${LAST_LINE_ANCHOR}\n\n` +
      `/** Settings backing the offline client's "Offline" pause-menu screen (app-settings-menu.js). */\n` +
      `export interface OfflineSettings {\n` +
      `  backupProvider: number;\n` +
      `  connectAccount: number;\n` +
      `  disconnectAccount: number;\n` +
      `  backupSave: number;\n` +
      `  restoreBackup: number;\n` +
      `  includeCurrentRun: boolean;\n` +
      `  lastBackupPlayed: number;\n` +
      `  clearAllData: number;\n` +
      `  forceDailySeed: number;\n` +
      `  dailySeedValue: number;\n` +
      `  dailySeedFetched: number;\n` +
      `  dailySeedExpires: number;\n` +
      `  updatePopUps: boolean;\n` +
      `  damageRange: boolean;\n` +
      `  enemyHpPercent: boolean;\n` +
      `  touchOverlayOpacity: number;\n` +
      `}\n\n` +
      `/** All keys for the offline settings */\n` +
      `export type OfflineSettingsKey = keyof OfflineSettings;`,
  );

  writeFile(TYPES_PATH, typesSrc);
}

// 6b. src/system/settings/default-settings.ts
const DEFAULTS_PATH = path.join("pokerogue-src", "src", "system", "settings", "default-settings.ts");
let defaultsSrc = readFile(DEFAULTS_PATH);

if (defaultsSrc.includes("defaultOfflineSettings")) {
  console.log("SKIP default-settings.ts — defaultOfflineSettings already present");
} else {
  const IMPORT_ANCHOR =
    `import type {\n` +
    `  AudioSettings,\n` +
    `  DisplaySettings,\n` +
    `  GamepadSettings,\n` +
    `  GeneralSettings,\n` +
    `  UserFacingSettings,\n` +
    `} from "#types/settings";`;
  requireAnchor(defaultsSrc, IMPORT_ANCHOR, "type import block in default-settings.ts");
  defaultsSrc = defaultsSrc.replace(
    IMPORT_ANCHOR,
    `import type {\n` +
      `  AudioSettings,\n` +
      `  DisplaySettings,\n` +
      `  GamepadSettings,\n` +
      `  GeneralSettings,\n` +
      `  OfflineSettings,\n` +
      `  UserFacingSettings,\n` +
      `} from "#types/settings";`,
  );

  const DEFAULTS_ANCHOR =
    `const defaultGamepadSettings: GamepadSettings = {\n` +
    `  activeIndex: 0,\n` +
    `  enabled: true,\n` +
    `};\n` +
    `\n` +
    `export const defaultSettings: UserFacingSettings = {\n` +
    `  audio: defaultAudioSettings,\n` +
    `  display: defaultDisplaySettings,\n` +
    `  gamepad: defaultGamepadSettings,\n` +
    `  general: defaultGeneralSettings,\n` +
    `};`;
  requireAnchor(defaultsSrc, DEFAULTS_ANCHOR, "defaultGamepadSettings/defaultSettings block in default-settings.ts");
  defaultsSrc = defaultsSrc.replace(
    DEFAULTS_ANCHOR,
    `const defaultGamepadSettings: GamepadSettings = {\n` +
      `  activeIndex: 0,\n` +
      `  enabled: true,\n` +
      `};\n` +
      `\n` +
      `// app-settings-menu: action rows (Connect/Backup/Restore/etc.) don't have a\n` +
      `// meaningful "value" of their own — they store a placeholder 0, same shape\n` +
      `// as their single-option SettingsUiItem row. Real toggles/values are typed\n` +
      `// normally.\n` +
      `const defaultOfflineSettings: OfflineSettings = {\n` +
      `  backupProvider: 0,\n` +
      `  connectAccount: 0,\n` +
      `  disconnectAccount: 0,\n` +
      `  backupSave: 0,\n` +
      `  restoreBackup: 0,\n` +
      `  includeCurrentRun: false,\n` +
      `  lastBackupPlayed: 0,\n` +
      `  clearAllData: 0,\n` +
      `  forceDailySeed: 0,\n` +
      `  dailySeedValue: 0,\n` +
      `  dailySeedFetched: 0,\n` +
      `  dailySeedExpires: 0,\n` +
      `  updatePopUps: true,\n` +
      `  damageRange: false,\n` +
      `  enemyHpPercent: false,\n` +
      `  touchOverlayOpacity: 0.8, // matches the previous hardcoded idle opacity\n` +
      `};\n` +
      `\n` +
      `export const defaultSettings: UserFacingSettings = {\n` +
      `  audio: defaultAudioSettings,\n` +
      `  display: defaultDisplaySettings,\n` +
      `  gamepad: defaultGamepadSettings,\n` +
      `  general: defaultGeneralSettings,\n` +
      `  offline: defaultOfflineSettings,\n` +
      `};`,
  );

  writeFile(DEFAULTS_PATH, defaultsSrc);
}

// 6c. src/system/settings/settings-manager.ts
const MANAGER_PATH = path.join("pokerogue-src", "src", "system", "settings", "settings-manager.ts");
let managerSrc = readFile(MANAGER_PATH);

if (managerSrc.includes("get offline()")) {
  console.log("SKIP settings-manager.ts — offline getter already present");
} else {
  const GETTER_ANCHOR =
    `  /** Getter for gamepad settings */\n` +
    `  public get gamepad() {\n` +
    `    return this._settings.gamepad;\n` +
    `  }`;
  requireAnchor(managerSrc, GETTER_ANCHOR, "gamepad getter in settings-manager.ts");
  managerSrc = managerSrc.replace(
    GETTER_ANCHOR,
    `${GETTER_ANCHOR}\n\n` +
      `  /** Getter for offline settings (app-settings-menu.js) */\n` +
      `  public get offline() {\n` +
      `    return this._settings.offline;\n` +
      `  }`,
  );

  const DESTRUCTURE_ANCHOR = `const { general, audio, display, gamepad } = lsSettings;`;
  requireAnchor(managerSrc, DESTRUCTURE_ANCHOR, "lsSettings destructure in settings-manager.ts");
  managerSrc = managerSrc.replace(
    DESTRUCTURE_ANCHOR,
    `const { general, audio, display, gamepad, offline } = lsSettings;`,
  );

  const MERGE_ANCHOR =
    `        if (gamepad) {\n` +
    `          this._settings.gamepad = { ...this._settings.gamepad, ...gamepad };\n` +
    `        }\n` +
    `      } catch (err) {`;
  requireAnchor(managerSrc, MERGE_ANCHOR, "gamepad merge block in settings-manager.ts loadFromLocalStorage()");
  managerSrc = managerSrc.replace(
    MERGE_ANCHOR,
    `        if (gamepad) {\n` +
      `          this._settings.gamepad = { ...this._settings.gamepad, ...gamepad };\n` +
      `        }\n\n` +
      `        if (offline) {\n` +
      `          this._settings.offline = { ...this._settings.offline, ...offline };\n` +
      `        }\n` +
      `      } catch (err) {`,
  );

  writeFile(MANAGER_PATH, managerSrc);
}

// 6d. src/ui/settings/settings-ui-items.ts
const UI_ITEMS_PATH = path.join("pokerogue-src", "src", "ui", "settings", "settings-ui-items.ts");
let uiItemsSrc = readFile(UI_ITEMS_PATH);

if (uiItemsSrc.includes("offlineBackupUiItems")) {
  console.log("SKIP settings-ui-items.ts — offlineBackupUiItems already present");
} else {
  const IMPORT_ANCHOR = `  GeneralSettingsKey,\n  SettingsUiItem,`;
  requireAnchor(uiItemsSrc, IMPORT_ANCHOR, "type import block in settings-ui-items.ts");
  uiItemsSrc = uiItemsSrc.replace(IMPORT_ANCHOR, `  GeneralSettingsKey,\n  OfflineSettingsKey,\n  SettingsUiItem,`);

  const END_ANCHOR = `// #endregion Audio Settings`;
  requireAnchor(uiItemsSrc, END_ANCHOR, "end of file marker in settings-ui-items.ts");
  uiItemsSrc = uiItemsSrc.replace(
    END_ANCHOR,
    `${END_ANCHOR}\n\n` +
      `// #region Offline Settings — Backup\n` +
      `\n` +
      `/** UI items for the offline client's "Backup" screen (app-settings-menu.js) */\n` +
      `export const offlineBackupUiItems: SettingsUiItem<OfflineSettingsKey>[] = [\n` +
      `  {\n` +
      `    key: "backupProvider",\n` +
      `    label: "Backup Provider",\n` +
      `    // Text is overwritten at runtime to whichever provider is active —\n` +
      `    // pressing ACTION on this row opens a scrollable provider picker.\n` +
      `    options: [{ value: 0, label: "Google Drive" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "connectAccount",\n` +
      `    label: "Connect Account",\n` +
      `    options: [{ value: 0, label: "Not Connected" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "disconnectAccount",\n` +
      `    label: "Disconnect Account",\n` +
      `    options: [{ value: 0, label: "Disconnect" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "backupSave",\n` +
      `    label: "Backup Save",\n` +
      `    // Text is overwritten at runtime to the active provider's display name.\n` +
      `    options: [{ value: 0, label: "Google Drive" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "restoreBackup",\n` +
      `    label: "Restore Backup",\n` +
      `    options: [{ value: 0, label: "Restore" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "includeCurrentRun",\n` +
      `    label: "Include Current Run",\n` +
      `    options: useOnOffOptions(),\n` +
      `  },\n` +
      `  {\n` +
      `    key: "lastBackupPlayed",\n` +
      `    label: "Last Backup Played",\n` +
      `    options: [{ value: 0, label: "—" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "clearAllData",\n` +
      `    label: "Clear All Data",\n` +
      `    options: [{ value: 0, label: "Clear" }],\n` +
      `  },\n` +
      `];\n` +
      `\n` +
      `// #endregion Offline Settings — Backup\n` +
      `\n` +
      `// #region Offline Settings — Preferences\n` +
      `\n` +
      `/** UI items for the offline client's "Preferences" screen (app-settings-menu.js) */\n` +
      `export const offlinePreferencesUiItems: SettingsUiItem<OfflineSettingsKey>[] = [\n` +
      `  {\n` +
      `    key: "forceDailySeed",\n` +
      `    label: "Force Daily Seed",\n` +
      `    options: [{ value: 0, label: "Update" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "dailySeedValue",\n` +
      `    label: "Daily Seed Value",\n` +
      `    options: [{ value: 0, label: "None" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "dailySeedFetched",\n` +
      `    label: "Daily Seed Fetched",\n` +
      `    options: [{ value: 0, label: "—" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "dailySeedExpires",\n` +
      `    label: "Daily Seed Expires",\n` +
      `    options: [{ value: 0, label: "—" }],\n` +
      `  },\n` +
      `  {\n` +
      `    key: "updatePopUps",\n` +
      `    label: "Update Pop-Ups",\n` +
      `    options: useOnOffOptions(),\n` +
      `  },\n` +
      `  {\n` +
      `    // Fight-menu damage-range/KO-label preview (patches/all/node/damage-preview.js).\n` +
      `    key: "damageRange",\n` +
      `    label: "Damage Range",\n` +
      `    options: useOnOffOptions(),\n` +
      `  },\n` +
      `  {\n` +
      `    // Enemy HP% preview (patches/all/node/damage-preview.js).\n` +
      `    key: "enemyHpPercent",\n` +
      `    label: "Enemy HP %",\n` +
      `    options: useOnOffOptions(),\n` +
      `  },\n` +
      `  {\n` +
      `    // Idle opacity of the on-screen D-pad/action buttons\n` +
      `    // (patches/all/node/touch-overlay-idle-opacity.js adds the\n` +
      `    // --touch-control-idle-opacity CSS var those elements read). Applied\n` +
      `    // live/on boot by the "touchOverlayOpacity" case added to\n` +
      `    // battle-scene.ts's initSettingsEventListeners() (sub-patch 6).\n` +
      `    key: "touchOverlayOpacity",\n` +
      `    label: "Touch Button Opacity",\n` +
      `    options: Array.from({ length: 10 }).map((_, i) => ({\n` +
      `      value: Number(((i + 1) * 0.1).toFixed(1)),\n` +
      `      label: \`\${(i + 1) * 10}\`,\n` +
      `    })),\n` +
      `    touchscreenOnly: true,\n` +
      `  },\n` +
      `];\n` +
      `\n` +
      `// #endregion Offline Settings — Preferences`,
  );

  writeFile(UI_ITEMS_PATH, uiItemsSrc);
}

// 6e. src/battle-scene.ts  →  live-apply Touch Button Opacity
const BATTLE_SCENE_PATH = path.join("pokerogue-src", "src", "battle-scene.ts");
let battleSceneSrc = readFile(BATTLE_SCENE_PATH);

if (battleSceneSrc.includes("touchOverlayOpacity")) {
  console.log("SKIP battle-scene.ts — touchOverlayOpacity listener already present");
} else {
  const LISTENER_ANCHOR =
    `      if (key === "shopOverlayOpacity" && typeof value === "number") {\n` +
    `        this.updateShopOverlayOpacity(value);\n` +
    `        return;\n` +
    `      }\n` +
    `    });`;
  requireAnchor(battleSceneSrc, LISTENER_ANCHOR, "shopOverlayOpacity listener in battle-scene.ts");
  battleSceneSrc = battleSceneSrc.replace(
    LISTENER_ANCHOR,
    `      if (key === "shopOverlayOpacity" && typeof value === "number") {\n` +
      `        this.updateShopOverlayOpacity(value);\n` +
      `        return;\n` +
      `      }\n\n` +
      `      if (key === "touchOverlayOpacity" && typeof value === "number") {\n` +
      `        const touchControls = document.getElementById("touchControls");\n` +
      `        if (touchControls) {\n` +
      `          touchControls.style.setProperty("--touch-control-idle-opacity", value.toString());\n` +
      `        }\n` +
      `        return;\n` +
      `      }\n` +
      `    });`,
  );

  writeFile(BATTLE_SCENE_PATH, battleSceneSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 8: src/ui/handlers/menu-ui-handler.ts  →  pause-menu entry point
// ─────────────────────────────────────────────────────────────────────────────

const MENU_PATH = path.join("pokerogue-src", "src", "ui", "handlers", "menu-ui-handler.ts");
let menuSrc = readFile(MENU_PATH);

if (menuSrc.includes("MenuOptions.OFFLINE")) {
  console.log("SKIP menu-ui-handler.ts — MenuOptions.OFFLINE already present");
} else {
  // 8a. MenuOptions enum — insert right after GAME_SETTINGS.
  const ENUM_ANCHOR = `enum MenuOptions {\n  GAME_SETTINGS,`;
  requireAnchor(menuSrc, ENUM_ANCHOR, "GAME_SETTINGS in MenuOptions enum");
  menuSrc = menuSrc.replace(ENUM_ANCHOR, `enum MenuOptions {\n  GAME_SETTINGS,\n  OFFLINE,`);

  // 8b. Label rendering — special-case OFFLINE to a hardcoded label instead
  // of an i18next lookup (offline-client-only feature, same reasoning as
  // the "Gacha Calendar" menu entry). gacha-calendar.js's own label-map
  // sub-patch is updated separately to chain onto this ternary, since
  // apply-patches.sh always runs this patch first.
  const LABEL_ANCHOR =
    `      return {\n` +
    `        label: \`\${i18next.t(\`menuUiHandler:\${toCamelCase(MenuOptions[option])}\`)}\`,\n` +
    `        handler: () => this.optionSelected(option),\n` +
    `        keepOpen: true,\n` +
    `      };`;
  requireAnchor(menuSrc, LABEL_ANCHOR, "menuOptions label map in menu-ui-handler.ts");
  menuSrc = menuSrc.replace(
    LABEL_ANCHOR,
    `      return {\n` +
      `        label:\n` +
      `          option === MenuOptions.OFFLINE\n` +
      `            ? "Offline"\n` +
      `            : \`\${i18next.t(\`menuUiHandler:\${toCamelCase(MenuOptions[option])}\`)}\`,\n` +
      `        handler: () => this.optionSelected(option),\n` +
      `        keepOpen: true,\n` +
      `      };`,
  );

  // 8c. Switch-case — open the Backup sub-tab (the landing screen). Same
  // pattern as GAME_SETTINGS (no revertMode first — Cancel/Back returns to
  // the pause menu, not straight to gameplay).
  const CASE_ANCHOR =
    `      case MenuOptions.GAME_SETTINGS:\n` +
    `        ui.setOverlayMode(UiMode.SETTINGS_GENERAL);\n` +
    `        success = true;\n` +
    `        break;`;
  requireAnchor(menuSrc, CASE_ANCHOR, "MenuOptions.GAME_SETTINGS switch-case in menu-ui-handler.ts");
  menuSrc = menuSrc.replace(
    CASE_ANCHOR,
    `${CASE_ANCHOR}\n` +
      `      case MenuOptions.OFFLINE:\n` +
      `        ui.setOverlayMode(UiMode.SETTINGS_OFFLINE_BACKUP);\n` +
      `        success = true;\n` +
      `        break;`,
  );

  writeFile(MENU_PATH, menuSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 9: src/ui-inputs.ts  →  add both Offline handlers to the
//   buttonCycleOption() whitelist, so Button.CYCLE_SHINY/CYCLE_FORM (the
//   tab-switch keys) actually reach their processInput().
// ─────────────────────────────────────────────────────────────────────────────

const UI_INPUTS_PATH = path.join("pokerogue-src", "src", "ui-inputs.ts");
let uiInputsSrc = readFile(UI_INPUTS_PATH);

if (uiInputsSrc.includes("OfflineBackupUiHandler")) {
  console.log("SKIP ui-inputs.ts — OfflineBackupUiHandler already present");
} else {
  const IMPORT_ANCHOR = `import { SettingsKeyboardUiHandler } from "#ui/keyboard-settings-ui-handler";`;
  requireAnchor(uiInputsSrc, IMPORT_ANCHOR, "SettingsKeyboardUiHandler import in ui-inputs.ts");
  uiInputsSrc = uiInputsSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\n` +
      `import { OfflineBackupUiHandler } from "#ui/offline-backup-ui-handler";\n` +
      `import { OfflinePreferencesUiHandler } from "#ui/offline-preferences-ui-handler";`,
  );

  const WHITELIST_ANCHOR = `SettingsKeyboardUiHandler,\n    ];`;
  requireAnchor(uiInputsSrc, WHITELIST_ANCHOR, "whitelist array in buttonCycleOption() in ui-inputs.ts");
  uiInputsSrc = uiInputsSrc.replace(
    WHITELIST_ANCHOR,
    `SettingsKeyboardUiHandler,\n      OfflineBackupUiHandler,\n      OfflinePreferencesUiHandler,\n    ];`,
  );

  writeFile(UI_INPUTS_PATH, uiInputsSrc);
}

console.log("\napp-settings-menu patch applied successfully.");
