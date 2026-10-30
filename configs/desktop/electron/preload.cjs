const { contextBridge, ipcRenderer } = require('electron');

// Exposed to the renderer as `window.pkrOffline`. Kept intentionally tiny —
// just enough for the Drive backup flow (src/system/offline/google-drive-backup.ts
// checks for `window.pkrOffline` to detect it's running under Electron).
contextBridge.exposeInMainWorld('pkrOffline', {
  /**
   * Runs the full Google sign-in flow. Internally, main.cjs tries a stored
   * refresh token first (silent, no browser popup) and only falls back to
   * the interactive browser flow if there's no stored token or it's stopped
   * working — so calling this on every app launch is intentional, not
   * wasteful, and is how the connection now survives restarts.
   */
  googleSignIn: () => ipcRenderer.invoke('google-sign-in'),

  /** Fast, no-network check for "do we have a stored connection to try restoring". */
  hasStoredGoogleCredentials: () => ipcRenderer.invoke('google-has-stored-credentials'),

  /** Forgets the stored connection entirely. */
  googleSignOut: () => ipcRenderer.invoke('google-sign-out'),

  /** Dropbox equivalents of the three methods above — same "try stored, else interactive" shape. */
  dropboxSignIn: () => ipcRenderer.invoke('dropbox-sign-in'),
  hasStoredDropboxCredentials: () => ipcRenderer.invoke('dropbox-has-stored-credentials'),
  dropboxSignOut: () => ipcRenderer.invoke('dropbox-sign-out'),

  /** Self-updater (updater.cjs) — resolves to null when no update is available. */
  checkForUpdate: () => ipcRenderer.invoke('updater-check'),

  /** Downloads + checksum-verifies the applicable release asset for this platform. Progress via onUpdateProgress. */
  downloadUpdate: () => ipcRenderer.invoke('updater-download'),

  /** Aborts an in-flight downloadUpdate() call. */
  cancelDownload: () => ipcRenderer.send('updater-cancel-download'),

  /** Only one listener is ever needed at a time, so this replaces any previous one rather than stacking. */
  onUpdateProgress: cb => {
    ipcRenderer.removeAllListeners('updater-download-progress');
    ipcRenderer.on('updater-download-progress', (_e, data) => cb(data));
  },

  /** Swaps the verified download into place and relaunches — only call after downloadUpdate() has resolved. */
  applyUpdateAndRelaunch: () => ipcRenderer.invoke('updater-apply-and-relaunch'),

  /** Pushed whenever the title screen is entered/left, so main.cjs can enable/disable the Tools > Check for Updates menu item. */
  notifyTitleScreenState: isTitleScreen => ipcRenderer.send('title-screen-state', isTitleScreen),

  /** Fired when the Tools > Check for Updates menu item is clicked (only ever enabled while on the title screen). */
  onCheckForUpdatesRequested: cb => {
    ipcRenderer.removeAllListeners('menu-check-for-updates');
    ipcRenderer.on('menu-check-for-updates', () => cb());
  },

  /** Lets main.cjs show a native dialog for the cases the Update Available screen itself has nothing to display for. */
  reportUpdateCheckResult: result => ipcRenderer.send('updater-check-result', result),

  /** Pushed on every change (edge-triggered) by the same title-ui-handler.ts polling interval that drives the Tools-menu title-screen check. */
  updateDiscordPresence: state => ipcRenderer.send('discord-rpc-update-presence', state),

  /** Pushed once at boot with the persisted setting, then again on every change - see discord-rpc.cjs. */
  setDiscordRichPresenceEnabled: isEnabled => ipcRenderer.send('discord-rpc-set-enabled', isEnabled),
});
