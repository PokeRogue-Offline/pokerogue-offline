import { globalScene } from "#app/global-scene";
import { TextStyle } from "#enums/text-style";
import { UiMode } from "#enums/ui-mode";
import type { OfflineSettingsKey, SettingsUiItem } from "#types/settings";
import * as backupManager from "#system/offline/backup-manager";
import { BaseSettingsUiHandler } from "#ui/base-settings-ui-handler";
import { offlineSettingsUiItems } from "#ui/settings-ui-items";
import { getTextColor } from "#ui/text";

/**
 * Scooom's "Offline" tab in the real Settings screen — sits alongside
 * General/Display/Audio/Gamepad/Keyboard, registered via the `settingsTabs`
 * array in `base-settings-ui-handler.ts` and the `offline` settings category
 * added to `#types/settings.ts`/`default-settings.ts`/`settings-manager.ts`.
 *
 * Rows, in display order (locked ones grouped together):
 *   - Backup Provider (always interactive — opens a scrollable picker over
 *     Google Drive/Dropbox/...; authenticating a provider here forgets every
 *     other provider's stored credentials/fingerprint, see
 *     backup-manager.ts's authenticateActiveProvider())
 *   - Connect Account (always interactive)
 *   - Disconnect Account              \
 *   - Backup Save                      } locked until connected
 *   - Restore Backup                   |
 *   - Include Current Run (Off/On)    /
 *   - Last Backup Played (read-only, populates once connected — not
 *     itself "locked", just shows a placeholder until there's something
 *     to show)
 *   - Clear All Data (always interactive — wiping local data has nothing
 *     to do with being connected)
 *
 * Every call in this file goes through `#system/offline/backup-manager`,
 * never a specific provider module directly — the manager is what decides
 * which provider ("Backup Provider" row) is currently active. See that
 * module and `#system/offline/backup-provider` for the provider interface
 * and anti-overwrite design.
 *
 * "Include Current Run" is a genuine two-option Setting (not activatable),
 * so its Left/Right cycling and persistence are entirely free — the base
 * class's existing generic mechanism handles it with zero code from us,
 * same as every other real setting in the game. It governs whether
 * backupSave() includes sessionData keys; restoreFromBackup() doesn't need
 * to know about the toggle at all, since it just writes back whatever a
 * given backup actually contains.
 *
 * The "activatable" action rows (Backup Provider, Connect, Disconnect,
 * Backup Save, Restore Backup, Clear All Data, Force Daily Seed) rely on
 * `activateSetting()`, a small extension point added to
 * `base-settings-ui-handler.ts` (upstream's rewritten settings UI has no
 * concept of action rows — every other tab's rows just cycle values).
 *
 * NOTE: This has not been exercised in a live Phaser build yet. The
 * `settingLabels`/`optionValueLabels`/`optionCursors` visibility changes
 * this depends on (private -> protected in base-settings-ui-handler.ts),
 * and the new `activateSetting()` hook, have been verified to compile but
 * not confirmed on a real device/build.
 */
// Must stay in sync with patches/all/node/fix-daily-seed.js — that patch
// owns the actual daily-run seed consumption, this handler only reads/writes
// the same three localStorage keys to display and force-refresh the cache.
const DAILY_SEED_URL = "https://pokerogue-offline.github.io/pokerogue-offline/daily-seed.txt";
const DAILY_SEED_KEY = "daily_seed";
const DAILY_SEED_DATE_KEY = "daily_seed_date";
const DAILY_SEED_FETCHED_AT_KEY = "daily_seed_fetched_at";

export class OfflineSettingsUiHandler extends BaseSettingsUiHandler {
  /** Rows that get greyed out and made inert while the active provider isn't authenticated. */
  private static readonly LOCKABLE_KEYS: OfflineSettingsKey[] = [
    "backupSave",
    "restoreBackup",
    "includeCurrentRun",
    "disconnectAccount",
  ];

  /**
   * Rows that are always greyed out / inert, regardless of sign-in state —
   * pure info rows for the daily seed cache, unrelated to backups.
   */
  private static readonly ALWAYS_LOCKED_KEYS: OfflineSettingsKey[] = [
    "dailySeedValue",
    "dailySeedFetched",
    "dailySeedExpires",
  ];

  /**
   * True after a restore has completed this screen-open — a second press on
   * "Restore Backup" reloads instead of restoring again. Deliberately reset
   * every time the tab opens (see show()) rather than persisted, so
   * navigating away and back always starts from a clean, unambiguous state.
   */
  private restoreComplete = false;

  /**
   * True while a Connect press is in flight (or within the 1s post-settle
   * debounce window below) — prevents a double-tap from firing a second
   * authenticate() call and spawning a second native/browser sign-in prompt
   * on top of the first.
   */
  private connectInProgress = false;

  /** True while a Force Daily Seed fetch is in flight — prevents a double-tap. */
  private forceSeedInProgress = false;

  constructor() {
    super("offline", offlineSettingsUiItems);
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

  /**
   * Greys out (or restores) a row's label and every one of its value
   * options. Handles both our single-option action rows and genuine
   * multi-option rows (currently just "Include Current Run") — when
   * unlocking a multi-option row, the previously-selected option correctly
   * goes back to SETTINGS_SELECTED rather than every option looking the
   * same.
   */
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
    const selectedCursor = this.optionCursors[idx];
    values.forEach((valueText, optionIdx) => {
      const valueStyle = locked
        ? TextStyle.SETTINGS_LOCKED
        : optionIdx === selectedCursor
          ? TextStyle.SETTINGS_SELECTED
          : TextStyle.SETTINGS_VALUE;
      valueText.setColor(getTextColor(valueStyle)).setShadowColor(getTextColor(valueStyle, true));
    });
  }

  private applyLockedStyling(): void {
    const locked = !backupManager.getActiveProvider().isAuthenticated();
    for (const key of OfflineSettingsUiHandler.LOCKABLE_KEYS) {
      this.setRowLocked(key, locked);
    }
    for (const key of OfflineSettingsUiHandler.ALWAYS_LOCKED_KEYS) {
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
    this.setRowText("dailySeedExpires", OfflineSettingsUiHandler.formatRelative(expiry, now));

    const fetchedAtMs = fetchedAtRaw ? Number(fetchedAtRaw) : Number.NaN;
    this.setRowText(
      "dailySeedFetched",
      Number.isFinite(fetchedAtMs) ? OfflineSettingsUiHandler.formatRelative(new Date(fetchedAtMs), now) : "unknown",
    );
  }

  /**
   * One-time-per-session prompt offered right after a successful sign-in
   * (explicit Connect/provider-switch, or the silent tab-open reconnect): if
   * a backup already exists on the active provider, ask whether to restore
   * it now. This is the practical fix for a device that's never synced
   * before (and so would otherwise just silently decline to auto-upload
   * once it starts making progress) — it gives the player an easy, obvious
   * way to catch up before ever reaching an auto-sync checkpoint. Still
   * routes through the exact same manual restoreFromBackup() codepath as
   * the "Restore Backup" button — loading remains a player decision, just
   * offered rather than requiring the player to dig through Settings.
   *
   * No-ops (no dialog at all) if no backup exists — a first-time user
   * connecting for the first time should see nothing.
   *
   * "Already offered" is tracked persistently by backup-manager (see
   * `hasOfferedRestorePrompt`/`markRestorePromptOffered`), not as in-memory
   * state on this handler — the "yes" path below reloads the page, which
   * would otherwise wipe an in-memory guard and let the very next silent
   * `tryRestoreSession()` reconnect ask again. It's only cleared on a
   * genuinely new connection or an explicit disconnect, set at the very
   * start of the check (before any await) so the two trigger paths below
   * (explicit Connect press, and the silent tryRestoreSession() on tab open)
   * can't both slip past a stale guard if they resolve close together.
   */
  private offerRestorePromptIfNeeded(): void {
    if (backupManager.hasOfferedRestorePrompt()) {
      return;
    }
    backupManager.markRestorePromptOffered();

    const providerName = backupManager.getActiveProvider().displayName;

    backupManager
      .getRemoteLastPlayed()
      .then(lastPlayed => {
        if (!lastPlayed) {
          return;
        }
        const ui = this.getUi();
        ui.showText(
          `A backup was found on ${providerName} (last played ${lastPlayed}). Restore it now? This will overwrite your current local save.`,
          null,
          () => {
            ui.setOverlayMode(
              UiMode.CONFIRM,
              () => {
                ui.revertMode();
                this.showText("", 0);
                this.performRestore(true);
              },
              () => {
                ui.revertMode();
                this.showText("", 0);
              },
              false,
              0,
            );
          },
        );
      })
      .catch(err => {
        console.warn("Failed to check for an existing backup to offer restoring:", err);
      });
  }

  /** Guard for the top of every action handler except Connect/Backup Provider themselves. */
  private requireSignedIn(): boolean {
    if (backupManager.getActiveProvider().isAuthenticated()) {
      return true;
    }
    this.showText("Connect your account first.", 0, () => this.showText("", 0), 1500);
    return false;
  }

  private refreshDisplay(): void {
    const provider = backupManager.getActiveProvider();
    this.setRowText("backupProvider", provider.displayName);
    this.setRowText("connectAccount", provider.isAuthenticated() ? "Connected" : "Not Connected");
    this.setRowText("backupSave", provider.displayName);
    this.applyLockedStyling();
  }

  /** Fetches and displays the active provider's backup's embedded save time — only meaningful once connected. */
  private refreshLastBackupPlayed(): void {
    if (!backupManager.getActiveProvider().isAuthenticated()) {
      this.setRowText("lastBackupPlayed", "—");
      return;
    }
    this.setRowText("lastBackupPlayed", "Checking…");
    backupManager
      .getRemoteLastPlayed()
      .then(lastPlayed => {
        this.setRowText("lastBackupPlayed", lastPlayed ?? "No backup found");
      })
      .catch(err => {
        console.error("Failed to fetch last-played time:", err);
        this.setRowText("lastBackupPlayed", "—");
      });
  }

  public override show(args: any[]): boolean {
    const result = super.show(args);

    this.restoreComplete = false;
    this.setRowText("restoreBackup", "Restore");

    this.refreshDisplay();
    this.refreshLastBackupPlayed();
    this.refreshDailySeedInfo();

    // Attempt a silent reconnect on the active provider if we're not already
    // signed in this session. Fire-and-forget — show() itself stays
    // synchronous, the rows just update once this resolves.
    const provider = backupManager.getActiveProvider();
    if (!provider.isAuthenticated()) {
      this.setRowText("connectAccount", "Checking connection…");
      provider
        .tryRestoreSession()
        .then(restored => {
          this.refreshDisplay();
          this.refreshLastBackupPlayed();
          if (restored) {
            this.offerRestorePromptIfNeeded();
          }
        })
        .catch(err => {
          console.warn("Silent session restore failed:", err);
          this.refreshDisplay();
        });
    }

    return result;
  }

  /**
   * Overrides the base class's `activateSetting()` extension point to add
   * our action rows, falling back to super for everything else (which is a
   * no-op — currently no other offline row is activatable). Note "Include
   * Current Run" is NOT handled here — it's a normal cycling Setting, not
   * activatable, so it never reaches this method at all.
   */
  protected override activateSetting(uiItem: SettingsUiItem<OfflineSettingsKey>): boolean {
    switch (uiItem.key) {
      case "backupProvider":
        this.handleProviderSelectPress();
        return true;
      case "connectAccount":
        this.handleConnectPress();
        return true;
      case "disconnectAccount":
        this.handleDisconnectPress();
        return true;
      case "backupSave":
        this.handleBackupPress();
        return true;
      case "restoreBackup":
        this.handleRestorePress();
        return true;
      case "clearAllData":
        this.handleClearDataPress();
        return true;
      case "forceDailySeed":
        this.handleForceDailySeedPress();
        return true;
    }
    return super.activateSetting(uiItem);
  }

  /**
   * Opens a scrollable provider picker — the same `UiMode.OPTION_SELECT`
   * overlay Display's "Language" row uses — instead of blindly cycling
   * through `backupManager.getProviders()`. Adding a third provider later
   * needs nothing else here, since the option list is built from the
   * registry each time the row is pressed. Selecting an unauthenticated
   * provider immediately starts its auth flow, same as pressing Connect
   * directly.
   */
  private handleProviderSelectPress(): void {
    if (this.connectInProgress) {
      return;
    }

    const ui = this.getUi();
    const providers = backupManager.getProviders();
    const options = providers.map(provider => ({
      label: provider.displayName,
      handler: () => {
        backupManager.switchProvider(provider.id);
        ui.revertMode();
        this.refreshDisplay();
        this.refreshLastBackupPlayed();
        if (!provider.isAuthenticated()) {
          this.handleConnectPress();
        }
        return true;
      },
    }));
    options.push({
      label: "Back",
      handler: () => {
        ui.revertMode();
        return true;
      },
    });

    ui.setOverlayMode(UiMode.OPTION_SELECT, { options, maxOptions: options.length });
  }

  private handleDisconnectPress(): void {
    if (!this.requireSignedIn()) {
      return;
    }
    const providerName = backupManager.getActiveProvider().displayName;
    const ui = this.getUi();
    ui.showText(
      `Disconnect from ${providerName}? You'll need to sign in again to sync.`,
      null,
      () => {
        ui.setOverlayMode(
          UiMode.CONFIRM,
          () => {
            ui.revertMode();
            this.showText("", 0);
            backupManager
              .disconnectActiveProvider()
              .then(() => {
                this.refreshDisplay();
                this.refreshLastBackupPlayed();
              })
              .catch(err => {
                console.error("Disconnect failed:", err);
                this.showText("Disconnect failed. Check the console for details.", 0, () => this.showText("", 0), 1500);
              });
          },
          () => {
            ui.revertMode();
            this.showText("", 0);
          },
          false,
          0,
        );
      },
    );
  }

  private handleConnectPress(): void {
    const provider = backupManager.getActiveProvider();
    if (provider.isAuthenticated() || this.connectInProgress) {
      return;
    }
    this.connectInProgress = true;
    // Enforce a hard minimum lock on top of connectInProgress, so a fast
    // rejection can't be immediately re-tapped into spawning a second
    // sign-in prompt before the UI's had a chance to settle.
    const unlockAt = Date.now() + 1000;
    this.setRowText("connectAccount", "Connecting…");
    backupManager
      .authenticateActiveProvider()
      .then(() => {
        this.refreshDisplay();
        this.refreshLastBackupPlayed();
        this.offerRestorePromptIfNeeded();
      })
      .catch(err => {
        console.error("Sign-in failed:", err);
        this.showText("Sign-in failed. Check the console for details.", 0, () => this.showText("", 0), 1500);
        this.refreshDisplay();
      })
      .finally(() => {
        const remaining = unlockAt - Date.now();
        if (remaining > 0) {
          setTimeout(() => {
            this.connectInProgress = false;
          }, remaining);
        } else {
          this.connectInProgress = false;
        }
      });
  }

  private handleBackupPress(): void {
    if (!this.requireSignedIn()) {
      return;
    }
    const providerName = backupManager.getActiveProvider().displayName;
    this.setRowText("backupSave", "Backing up…");
    backupManager
      .backupSave()
      .then(() => {
        this.setRowText("backupSave", providerName);
        this.showText("Backup complete.", 0, () => this.showText("", 0), 1500);
        this.refreshLastBackupPlayed();
      })
      .catch(err => {
        console.error("Backup failed:", err);
        this.setRowText("backupSave", providerName);
        this.showText("Backup failed. Check the console for details.", 0, () => this.showText("", 0), 1500);
      })
      .finally(() => {
        globalScene.ui.playSelect();
      });
  }

  private handleRestorePress(): void {
    if (!this.requireSignedIn()) {
      return;
    }

    if (this.restoreComplete) {
      window.location.reload();
      return;
    }

    const providerName = backupManager.getActiveProvider().displayName;
    const ui = this.getUi();
    ui.showText(
      `This will overwrite your current save data with your ${providerName} backup. Continue?`,
      null,
      () => {
        ui.setOverlayMode(
          UiMode.CONFIRM,
          () => {
            ui.revertMode();
            this.showText("", 0);
            this.performRestore();
          },
          () => {
            ui.revertMode();
            this.showText("", 0);
          },
          false,
          0,
        );
      },
    );
  }

  /**
   * @param reloadOnSuccess - When true (the auto-restore prompt's confirm
   * path), reload the page immediately on success instead of requiring a
   * second manual press on "Restore Backup" — the prompt already got an
   * explicit "yes" from the player, so there's nothing left to confirm.
   */
  private performRestore(reloadOnSuccess = false): void {
    this.setRowText("restoreBackup", "Restoring…");
    backupManager
      .restoreFromBackup()
      .then(() => {
        if (reloadOnSuccess) {
          window.location.reload();
          return;
        }
        this.restoreComplete = true;
        this.setRowText("restoreBackup", "Press Confirm to reload");
      })
      .catch(err => {
        console.error("Restore failed:", err);
        this.setRowText("restoreBackup", "Restore");
        this.showText("Restore failed. Check the console for details.", 0, () => this.showText("", 0), 1500);
      });
  }

  private handleClearDataPress(): void {
    // Deliberately NOT gated behind requireSignedIn() — wiping local data has
    // nothing to do with being connected to a backup provider.
    const ui = this.getUi();
    ui.showText(
      "This will ERASE ALL local data — save, settings, everything — and cannot be undone. Continue?",
      null,
      () => {
        ui.setOverlayMode(
          UiMode.CONFIRM,
          () => {
            ui.revertMode();
            this.showText("", 0);
            localStorage.clear();
            window.location.reload();
          },
          () => {
            ui.revertMode();
            this.showText("", 0);
          },
          false,
          0,
          0,
          3000, // 3-second delay before "Yes" responds to input, per the plan.
        );
      },
    );
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
