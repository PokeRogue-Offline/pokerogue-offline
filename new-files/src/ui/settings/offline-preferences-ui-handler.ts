import { globalScene } from "#app/global-scene";
import { TextStyle } from "#enums/text-style";
import type { OfflineSettingsKey, SettingsUiItem } from "#types/settings";
import { BaseSettingsUiHandler } from "#ui/base-settings-ui-handler";
import { OFFLINE_TABS } from "#ui/offline-tabs";
import { offlinePreferencesUiItems } from "#ui/settings-ui-items";
import { getTextColor } from "#ui/text";

/**
 * Scooom's "Preferences" screen — the second sub-tab of the pause menu's
 * "Offline" entry, sibling-tabbed with OfflineBackupUiHandler via the shared
 * OFFLINE_TABS array (offline-tabs.ts). Was previously part of the same
 * combined tab as Backup; split out once that became its own screen so each
 * screen holds a sensible, roughly-equal-sized group of rows (backup/sync
 * concerns vs. everything else), mirroring how the real Settings screen
 * itself is split into General/Display/Audio/etc.
 *
 * Rows, in display order:
 *   - Force Daily Seed (activatable — re-fetches the cached daily-run seed
 *     on demand)
 *   - Daily Seed Value / Fetched / Expires (read-only info rows, always
 *     locked, reflecting the cache fix-daily-seed.js reads from)
 *   - Update Pop-Ups, Damage Range, Enemy HP %, Touch Button Opacity —
 *     genuine Settings (not activatable), so their Left/Right cycling and
 *     persistence are entirely free via the base class's generic mechanism,
 *     same as "Include Current Run" on the Backup screen.
 *
 * The "Force Daily Seed" action row relies on `activateSetting()`, a small
 * extension point added to `base-settings-ui-handler.ts` (upstream's
 * rewritten settings UI has no concept of action rows — every other tab's
 * rows just cycle values).
 *
 * NOTE: This has not been exercised in a live Phaser build yet.
 */
// Must stay in sync with patches/all/node/fix-daily-seed.js — that patch
// owns the actual daily-run seed consumption, this handler only reads/writes
// the same three localStorage keys to display and force-refresh the cache.
const DAILY_SEED_URL = "https://pokerogue-offline.github.io/pokerogue-offline/daily-seed.txt";
const DAILY_SEED_KEY = "daily_seed";
const DAILY_SEED_DATE_KEY = "daily_seed_date";
const DAILY_SEED_FETCHED_AT_KEY = "daily_seed_fetched_at";

export class OfflinePreferencesUiHandler extends BaseSettingsUiHandler {
  /** Read-only info rows for the daily seed cache — always greyed out/inert. */
  private static readonly ALWAYS_LOCKED_KEYS: OfflineSettingsKey[] = [
    "dailySeedValue",
    "dailySeedFetched",
    "dailySeedExpires",
  ];

  /** True while a Force Daily Seed fetch is in flight — prevents a double-tap. */
  private forceSeedInProgress = false;

  constructor() {
    super("offline", offlinePreferencesUiItems, OFFLINE_TABS);
  }

  private rowIndex(key: OfflineSettingsKey): number {
    return this.uiItems.findIndex(item => item.key === key);
  }

  /** Directly overwrites a single-option row's displayed value text. */
  private setRowText(key: OfflineSettingsKey, text: string): void {
    const idx = this.rowIndex(key);
    if (idx === -1) {
      return;
    }
    const label = this.optionValueLabels[idx]?.[0];
    if (label) {
      label.setText(text);
    }
  }

  /** Greys out a read-only row's label and its value text. */
  private setRowLocked(key: OfflineSettingsKey, locked: boolean): void {
    const idx = this.rowIndex(key);
    if (idx === -1) {
      return;
    }

    const labelStyle = locked ? TextStyle.SETTINGS_LOCKED : TextStyle.SETTINGS_LABEL;
    const labelText = this.settingLabels[idx];
    if (labelText) {
      labelText.setColor(getTextColor(labelStyle)).setShadowColor(getTextColor(labelStyle, true));
    }

    const values = this.optionValueLabels[idx] ?? [];
    values.forEach(valueText => {
      const valueStyle = locked ? TextStyle.SETTINGS_LOCKED : TextStyle.SETTINGS_VALUE;
      valueText.setColor(getTextColor(valueStyle)).setShadowColor(getTextColor(valueStyle, true));
    });
  }

  private applyLockedStyling(): void {
    for (const key of OfflinePreferencesUiHandler.ALWAYS_LOCKED_KEYS) {
      this.setRowLocked(key, true);
    }
  }

  /**
   * Formats the (always non-negative) gap between `target` and `now` as a
   * relative string, floored to 5-minute increments — e.g. "1h 45m ago",
   * "in 3h", "just now". Sub-5-minute gaps collapse to "just now"/"in a
   * moment" rather than showing "0m", since a 5-minute floor can't
   * distinguish "2 minutes ago" from "right now" anyway.
   */
  private static formatRelative(target: Date, now: Date): string {
    const diffMs = target.getTime() - now.getTime();
    const past = diffMs <= 0;
    const totalMinutesRaw = Math.floor(Math.abs(diffMs) / 60000);
    const totalMinutes = totalMinutesRaw - (totalMinutesRaw % 5); // floor to nearest 5

    if (totalMinutes < 5) {
      return past ? "just now" : "in a moment";
    }

    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;

    let body: string;
    if (days > 0) {
      body = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    } else if (hours > 0) {
      body = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    } else {
      body = `${mins}m`;
    }

    return past ? `${body} ago` : `in ${body}`;
  }

  /**
   * Reads the daily seed cache (written by fix-daily-seed.js, or by
   * handleForceDailySeedPress below) and reflects it in three read-only
   * rows: the seed value itself, when it was fetched, and when it expires.
   * Expiry is the next UTC midnight after the cached date, since that's
   * when fix-daily-seed.js's own date check invalidates the cache.
   */
  private refreshDailySeedInfo(): void {
    const seed = localStorage.getItem(DAILY_SEED_KEY);
    const cachedDate = localStorage.getItem(DAILY_SEED_DATE_KEY);
    const fetchedAtRaw = localStorage.getItem(DAILY_SEED_FETCHED_AT_KEY);

    this.setRowText("dailySeedValue", seed ?? "None");

    if (!seed || !cachedDate) {
      this.setRowText("dailySeedFetched", "—");
      this.setRowText("dailySeedExpires", "—");
      return;
    }

    const now = new Date();

    const expiry = new Date(`${cachedDate}T00:00:00.000Z`);
    expiry.setUTCDate(expiry.getUTCDate() + 1);
    this.setRowText("dailySeedExpires", OfflinePreferencesUiHandler.formatRelative(expiry, now));

    const fetchedAtMs = fetchedAtRaw ? Number(fetchedAtRaw) : Number.NaN;
    this.setRowText(
      "dailySeedFetched",
      Number.isFinite(fetchedAtMs)
        ? OfflinePreferencesUiHandler.formatRelative(new Date(fetchedAtMs), now)
        : "unknown",
    );
  }

  public override show(args: any[]): boolean {
    const result = super.show(args);

    this.applyLockedStyling();
    this.refreshDailySeedInfo();

    return result;
  }

  /**
   * Overrides the base class's `activateSetting()` extension point for
   * "Force Daily Seed", falling back to super for everything else (a no-op
   * — Update Pop-Ups/Damage Range/Enemy HP%/Touch Button Opacity all just
   * cycle values, never reaching this method at all).
   */
  protected override activateSetting(uiItem: SettingsUiItem<OfflineSettingsKey>): boolean {
    if (uiItem.key === "forceDailySeed") {
      this.handleForceDailySeedPress();
      return true;
    }
    return super.activateSetting(uiItem);
  }

  /**
   * Force-fetches the daily seed regardless of what's cached, overwriting
   * daily_seed / daily_seed_date / daily_seed_fetched_at on success. Not
   * gated behind sign-in — this has nothing to do with backups.
   * Deliberately does NOT go through title-phase.ts's handler; this is a
   * standalone refresh of the same cache that handler reads from.
   */
  private handleForceDailySeedPress(): void {
    if (this.forceSeedInProgress) {
      return;
    }
    this.forceSeedInProgress = true;
    this.setRowText("forceDailySeed", "Updating…");

    fetch(DAILY_SEED_URL)
      .then(r => {
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        return r.text();
      })
      .then(fetchedSeed => {
        const seed = fetchedSeed.trim();
        const todayUtc = new Date().toISOString().slice(0, 10);
        localStorage.setItem(DAILY_SEED_DATE_KEY, todayUtc);
        localStorage.setItem(DAILY_SEED_KEY, seed);
        localStorage.setItem(DAILY_SEED_FETCHED_AT_KEY, Date.now().toString());
        this.refreshDailySeedInfo();
        this.showText("Daily seed updated.", 0, () => this.showText("", 0), 1500);
      })
      .catch(err => {
        console.error("Force daily seed fetch failed:", err);
        this.showText("Could not fetch daily seed. Check the console for details.", 0, () => this.showText("", 0), 1500);
      })
      .finally(() => {
        this.setRowText("forceDailySeed", "Update");
        this.forceSeedInProgress = false;
        globalScene.ui.playSelect();
      });
  }
}
