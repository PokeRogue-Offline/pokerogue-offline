import { UiMode } from "#enums/ui-mode";

/**
 * The two sub-tabs shared by OfflineBackupUiHandler and
 * OfflinePreferencesUiHandler — their own small `TabMenu`, entirely
 * independent of the main Settings screen's 5-tab bar (General/Display/
 * Audio/Gamepad/Keyboard). A 6th entry there overflowed the tab bar's
 * hardcoded 320px width (no wrapping/scrolling exists in TabMenu), so the
 * Offline screen is reached from its own pause-menu entry instead — see
 * patches/all/node/app-settings-menu.js's menu-ui-handler.ts sub-patch.
 *
 * Both mode names must start with "SETTINGS" — index.css shows the
 * touch-controls F/R (prev/next tab) hint buttons via
 * `[data-ui-mode^="SETTINGS"]`, matched against the enum key's string name.
 */
export const OFFLINE_TABS = [
  { mode: UiMode.SETTINGS_OFFLINE_BACKUP, labelKey: "Backup" },
  { mode: UiMode.SETTINGS_OFFLINE_PREFERENCES, labelKey: "Preferences" },
];
