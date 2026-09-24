/**
 * Mirrors the localStorage-read pattern used elsewhere for fork-added
 * offline settings (e.g. `update-check.js`'s `updatePopUpsEnabled()`),
 * rather than going through upstream's `globalScene.<field>` wiring, which
 * the fork's own settings never use. Both flags default to off (absent key
 * -> `fallback: false`), per the "off by default" requirement.
 */
function readSettingFlag(key: "damageRange" | "enemyHpPercent"): boolean {
  try {
    const raw = localStorage.getItem("settings");
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw);
    return parsed?.offline?.[key] === true;
  } catch {
    return false;
  }
}

export function isDamageRangeEnabled(): boolean {
  return readSettingFlag("damageRange");
}

export function isEnemyHpPercentEnabled(): boolean {
  return readSettingFlag("enemyHpPercent");
}
