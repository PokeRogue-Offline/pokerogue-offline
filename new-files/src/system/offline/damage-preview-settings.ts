import { SettingKeys } from "#system/settings";

/**
 * Mirrors the localStorage-read pattern used elsewhere for fork-added
 * `SettingType.APP` toggles (e.g. `update-check.js`'s
 * `updatePopUpsEnabled()`), rather than going through upstream's
 * `globalScene.<field>` wiring, which the fork's own settings never use.
 * Both flags default to off (absent key -> `fallback: false`), per the
 * "off by default" requirement.
 */
function readSettingFlag(key: string): boolean {
  try {
    const raw = localStorage.getItem("settings");
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw);
    return parsed?.[key] === 1;
  } catch {
    return false;
  }
}

export function isDamageRangeEnabled(): boolean {
  return readSettingFlag(SettingKeys.Offline_Damage_Range);
}

export function isEnemyHpPercentEnabled(): boolean {
  return readSettingFlag(SettingKeys.Offline_Enemy_Hp_Percent);
}
