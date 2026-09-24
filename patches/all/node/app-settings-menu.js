#!/usr/bin/env node
/**
 * Patch: app-settings-menu.js
 *
 * Adds an "Offline" tab to the REAL Settings screen (alongside
 * General/Display/Audio/Gamepad/Keyboard).
 *
 * v10 of this patch. Changes from v9 — REWRITTEN for upstream's settings-UI
 * rework:
 *   - Upstream replaced the old flat `SettingType`/`SettingKeys`/`Setting[]`
 *     model (src/system/settings/settings.ts, now deleted) with a typed,
 *     per-category model: `UserFacingSettings` (audio/display/gamepad/
 *     general interfaces in src/@types/settings.ts), row definitions in
 *     src/ui/settings/settings-ui-items.ts, and a `SettingsManager` class
 *     (src/system/settings/settings-manager.ts) with hand-written getters
 *     per category. This patch adds a 5th "offline" category end-to-end:
 *     type, defaults, manager getter/load, and UI row definitions.
 *   - Upstream also replaced src/ui/settings/navigation-menu.ts (parallel
 *     modes/labels arrays) with a `settingsTabs` array + `TabMenu` component
 *     directly on BaseSettingsUiHandler. Sub-patch 5 now appends to that
 *     array instead of editing navigation-menu.ts.
 *   - The new BaseSettingsUiHandler has NO concept of "activatable" action
 *     rows at all (Button.ACTION is a no-op in its processInput() switch) —
 *     the old code only had to WIDEN a pre-existing activateSetting() method
 *     from private to protected. That method doesn't exist any more, so
 *     sub-patch 7 now ADDS a minimal activateSetting() extension point
 *     (base implementation: no-op, so every other tab is unaffected) and
 *     wires it into the Button.ACTION case, in addition to the same
 *     private->protected visibility widening as before (settingLabels/
 *     optionValueLabels/optionCursors — still needed, same field names).
 *   - src/ui/settings/settings-ui-handler.ts (General tab) was renamed to
 *     general-settings-ui-handler.ts and already has its own show()
 *     override (for touch-controls orientation labels) — sub-patch 8 now
 *     injects the prewarm logic into that existing override instead of
 *     appending a new one.
 *   - "Touch Button Opacity"'s live-apply hook used to be a case in
 *     settings.ts's setSetting() switch (also deleted). Reactive setting
 *     side effects now live in battle-scene.ts's initSettingsEventListeners()
 *     (an eventBus "settings/update/success" listener) — sub-patch 6 now
 *     adds a case there instead, alongside upstream's own shopOverlayOpacity
 *     example right next to it.
 *   - Sub-patches 1 (ui-mode.ts), 2 (backup-*.ts new files), 4 (ui.ts
 *     import/register/noTransitionModes), and 9 (ui-inputs.ts whitelist)
 *     are UNCHANGED from v9 — their anchors still match current upstream
 *     verbatim.
 *   - Every "Offline" row is now a properly typed, persisted setting
 *     (`settings.offline.<key>`) instead of a generic string-keyed row, so
 *     downstream patches that used to read `SettingKeys.Offline_X` via a
 *     raw localStorage parse (update-check.js's Update Pop-Ups check,
 *     damage-preview-settings.ts, backup-manager.ts's Include Current Run
 *     check) now read `parsed.offline.<camelCaseKey>` instead — see those
 *     files/patches for the corresponding updates.
 *
 * Sub-patches, applied in order:
 *
 *   1. src/enums/ui-mode.ts
 *        Append SETTINGS_OFFLINE (after ALERT_MODAL, the last entry).
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
 *   3. src/ui/settings/offline-settings-ui-handler.ts  (new file)
 *        Extends BaseSettingsUiHandler (same base class as the real
 *        General/Display/Audio tabs), constructed as
 *        `super("offline", offlineSettingsUiItems)`.
 *
 *   4. src/ui/ui.ts
 *        Import OfflineSettingsUiHandler, register at the position
 *        matching UiMode.SETTINGS_OFFLINE, add to noTransitionModes.
 *
 *   5. src/ui/settings/base-settings-ui-handler.ts  →  settingsTabs
 *        Append { mode: UiMode.SETTINGS_OFFLINE, labelKey: "Offline" } —
 *        this is what actually makes it show up as a 6th tab. Hardcoded
 *        label, deliberately not routed through i18next (i18next.t() on a
 *        namespace-less key just echoes it back, which is fine here) —
 *        offline-client-only feature.
 *
 *   6. src/@types/settings.ts, src/system/settings/default-settings.ts,
 *      src/system/settings/settings-manager.ts, src/ui/settings/settings-ui-items.ts,
 *      src/battle-scene.ts
 *        Add the "offline" settings category end-to-end: the OfflineSettings
 *        type (16 fields covering backup state, daily-seed cache display,
 *        the Update Pop-Ups/Damage Range/Enemy HP%/Touch Button Opacity
 *        toggles), its defaults, a manager getter + localStorage load/merge,
 *        the UI row definitions (offlineSettingsUiItems), and a live-apply
 *        case for Touch Button Opacity's CSS var.
 *
 *   7. src/ui/settings/base-settings-ui-handler.ts  →  widen + add hook
 *        Widen `settingLabels`, `optionValueLabels`, and `optionCursors`
 *        from private to protected (pure visibility changes — lets our
 *        subclass grey out / restyle rows and update displayed text after
 *        an async action completes). ADD a new `activateSetting()`
 *        extension point (base: no-op) and wire it into the Button.ACTION
 *        case of processInput() — see the v10 changelog note above.
 *
 *   8. src/ui/settings/general-settings-ui-handler.ts
 *        Inject into the existing show() override a call that fires the
 *        active provider's tryRestoreSession() (via backup-manager.ts)
 *        fire-and-forget. Prewarms the connection state so that if/when the
 *        player tabs over to Offline, the row already reflects "Connected"
 *        instead of a "Checking connection…" flash — all handler instances
 *        exist from boot (Ui.setup() constructs and calls setup() on every
 *        registered handler up front), so updating the Offline tab's state
 *        from here is safe even though it isn't the active tab.
 *
 *   9. src/ui-inputs.ts
 *        Import OfflineSettingsUiHandler and append it to the `whitelist`
 *        array in buttonCycleOption() — without this, Button.CYCLE_SHINY/
 *        CYCLE_FORM (the tab-switch keys) are silently dropped while the
 *        Offline tab is active.
 *
 * NOTE ON TESTING: all sub-patches have been checked against a fresh clone
 * of pagefaultgames/pokerogue (beta branch) and the anchors are confirmed
 * present at the time this was written, and the resulting tree has been
 * confirmed to build (`pnpm build --mode app`). The new UI handler's runtime
 * behavior (reaching into optionValueLabels/settingLabels/optionCursors
 * after construction, the activateSetting override, the UiMode.CONFIRM
 * delay/message flow) has NOT been verified in an actual running build.
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
  uiModeSrc = uiModeSrc.replace(ANCHOR, `${ANCHOR}\n  SETTINGS_OFFLINE,`);
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
// Sub-patch 5+7: src/ui/settings/base-settings-ui-handler.ts
//   → register the 6th tab, widen 3 fields to protected, add activateSetting()
// ─────────────────────────────────────────────────────────────────────────────

const BASE_HANDLER_PATH = path.join("pokerogue-src", "src", "ui", "settings", "base-settings-ui-handler.ts");
let baseHandlerSrc = readFile(BASE_HANDLER_PATH);

if (baseHandlerSrc.includes("UiMode.SETTINGS_OFFLINE")) {
  console.log("SKIP base-settings-ui-handler.ts — Offline tab already registered");
} else {
  // 5. Register the tab.
  const TABS_ANCHOR = `{ mode: UiMode.SETTINGS_KEYBOARD, labelKey: "settings:keyboard" },\n  ];`;
  requireAnchor(baseHandlerSrc, TABS_ANCHOR, "settingsTabs array in base-settings-ui-handler.ts");
  baseHandlerSrc = baseHandlerSrc.replace(
    TABS_ANCHOR,
    `{ mode: UiMode.SETTINGS_KEYBOARD, labelKey: "settings:keyboard" },\n    { mode: UiMode.SETTINGS_OFFLINE, labelKey: "Offline" },\n  ];`,
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
      `   * (e.g. the Offline tab's Connect/Backup/Restore buttons) that need to run\n` +
      `   * custom logic on Button.ACTION rather than just cycling an option value.\n` +
      `   * Base implementation is a no-op so every other tab's behavior (Button.ACTION\n` +
      `   * does nothing) is unchanged.\n` +
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
  typesSrc = typesSrc.replace(
    ANY_KEY_ANCHOR,
    `${ANY_KEY_ANCHOR.replace(";", "")} | OfflineSettingsKey;`,
  );

  const LAST_LINE_ANCHOR = `export type GamepadSettingsKey = keyof GamepadSettings;`;
  requireAnchor(typesSrc, LAST_LINE_ANCHOR, "GamepadSettingsKey type (end of file) in @types/settings.ts");
  typesSrc = typesSrc.replace(
    LAST_LINE_ANCHOR,
    `${LAST_LINE_ANCHOR}\n\n` +
      `/** Settings backing the offline client's "Offline" settings tab (app-settings-menu.js). */\n` +
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

if (uiItemsSrc.includes("offlineSettingsUiItems")) {
  console.log("SKIP settings-ui-items.ts — offlineSettingsUiItems already present");
} else {
  const IMPORT_ANCHOR = `  GeneralSettingsKey,\n  SettingsUiItem,`;
  requireAnchor(uiItemsSrc, IMPORT_ANCHOR, "type import block in settings-ui-items.ts");
  uiItemsSrc = uiItemsSrc.replace(IMPORT_ANCHOR, `  GeneralSettingsKey,\n  OfflineSettingsKey,\n  SettingsUiItem,`);

  const END_ANCHOR = `// #endregion Audio Settings`;
  requireAnchor(uiItemsSrc, END_ANCHOR, "end of file marker in settings-ui-items.ts");
  uiItemsSrc = uiItemsSrc.replace(
    END_ANCHOR,
    `${END_ANCHOR}\n\n` +
      `// #region Offline Settings\n` +
      `\n` +
      `/** UI items for the offline client's "Offline" settings tab (app-settings-menu.js) */\n` +
      `export const offlineSettingsUiItems: SettingsUiItem<OfflineSettingsKey>[] = [\n` +
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
      `// #endregion Offline Settings`,
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
// Sub-patch 8: src/ui/settings/general-settings-ui-handler.ts  →  prewarm connection on open
// ─────────────────────────────────────────────────────────────────────────────

const GENERAL_TAB_PATH = path.join("pokerogue-src", "src", "ui", "settings", "general-settings-ui-handler.ts");
let generalTabSrc = readFile(GENERAL_TAB_PATH);

if (generalTabSrc.includes("app-settings-menu: prewarm")) {
  console.log("SKIP general-settings-ui-handler.ts — prewarm already present");
} else {
  const IMPORT_ANCHOR = `import { BaseSettingsUiHandler } from "#ui/base-settings-ui-handler";`;
  requireAnchor(generalTabSrc, IMPORT_ANCHOR, "BaseSettingsUiHandler import in general-settings-ui-handler.ts");
  generalTabSrc = generalTabSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\nimport * as backupManager from "#system/offline/backup-manager";`,
  );

  const SHOW_ANCHOR =
    `  public override show(args: any[]): boolean {\n` +
    `    const ret = super.show(args);\n` +
    `\n` +
    `    this.updateMoveTouchControlsSettingsLabel();\n` +
    `\n` +
    `    return ret;\n` +
    `  }`;
  requireAnchor(generalTabSrc, SHOW_ANCHOR, "show() override in general-settings-ui-handler.ts");
  generalTabSrc = generalTabSrc.replace(
    SHOW_ANCHOR,
    `  public override show(args: any[]): boolean {\n` +
      `    const ret = super.show(args);\n` +
      `\n` +
      `    // app-settings-menu: prewarm the active backup provider's connection\n` +
      `    // state whenever the Settings screen is opened (General is always the\n` +
      `    // entry tab), so the Offline tab's row already reflects the resolved\n` +
      `    // state instead of a "Checking…" flash if/when the player tabs over to\n` +
      `    // it. No-op if already signed in this session.\n` +
      `    const provider = backupManager.getActiveProvider();\n` +
      `    if (!provider.isAuthenticated()) {\n` +
      `      provider.tryRestoreSession().catch(err => {\n` +
      `        console.warn("Silent session restore failed:", err);\n` +
      `      });\n` +
      `    }\n` +
      `\n` +
      `    this.updateMoveTouchControlsSettingsLabel();\n` +
      `\n` +
      `    return ret;\n` +
      `  }`,
  );

  writeFile(GENERAL_TAB_PATH, generalTabSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 9: src/ui-inputs.ts  →  add OfflineSettingsUiHandler to the
//   buttonCycleOption() whitelist, so Button.CYCLE_SHINY/CYCLE_FORM (the
//   tab-switch keys) actually reach the Offline tab's processInput().
// ─────────────────────────────────────────────────────────────────────────────

const UI_INPUTS_PATH = path.join("pokerogue-src", "src", "ui-inputs.ts");
let uiInputsSrc = readFile(UI_INPUTS_PATH);

if (uiInputsSrc.includes("OfflineSettingsUiHandler")) {
  console.log("SKIP ui-inputs.ts — OfflineSettingsUiHandler already present");
} else {
  const IMPORT_ANCHOR = `import { SettingsKeyboardUiHandler } from "#ui/keyboard-settings-ui-handler";`;
  requireAnchor(uiInputsSrc, IMPORT_ANCHOR, "SettingsKeyboardUiHandler import in ui-inputs.ts");
  uiInputsSrc = uiInputsSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\nimport { OfflineSettingsUiHandler } from "#ui/offline-settings-ui-handler";`,
  );

  const WHITELIST_ANCHOR = `SettingsKeyboardUiHandler,\n    ];`;
  requireAnchor(uiInputsSrc, WHITELIST_ANCHOR, "whitelist array in buttonCycleOption() in ui-inputs.ts");
  uiInputsSrc = uiInputsSrc.replace(
    WHITELIST_ANCHOR,
    `SettingsKeyboardUiHandler,\n      OfflineSettingsUiHandler,\n    ];`,
  );

  writeFile(UI_INPUTS_PATH, uiInputsSrc);
}

console.log("\napp-settings-menu patch applied successfully.");
