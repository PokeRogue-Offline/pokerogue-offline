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
});
