/**
 * Shared contract for a cloud backup provider (Google Drive, Dropbox, ...),
 * plus the provider-agnostic anti-overwrite safety check every provider is
 * gated behind. See `#system/offline/backup-manager` for the module that
 * actually routes `backupSave()`/`restoreFromBackup()`/`autoSyncCheckpoint()`
 * to whichever provider is currently active — this file only defines the
 * shape a provider implements and the pure decision logic shared by all of
 * them.
 *
 * ── Anti-overwrite design (shared by every provider) ────────────────────
 *
 * The problem: the same account can be signed into multiple devices, each
 * with its own local save. Device clocks aren't trustworthy or synced across
 * devices, so "is it safe to overwrite" can't be based on wall-clock time.
 *
 * The fix: an ETag-style optimistic-concurrency fingerprint. Every successful
 * upload or restore remembers the remote's fingerprint locally (see
 * `#system/offline/backup-manager`'s per-provider fingerprint keys —
 * deliberately excluded from the backup payload itself via
 * `SYNC_STATE_KEY_PATTERN`, since this is device-local bookkeeping, not save
 * data). Before an AUTO upload, the remote's current fingerprint is
 * re-checked: if it still matches what this device remembers, nothing else
 * has written to the remote since this device last synced, so it's safe to
 * overwrite. If it differs — or nothing is remembered yet — a remote write
 * this device doesn't know about exists, and the auto-upload is silently
 * skipped (no dialog, no retry storm — just wait for the next checkpoint, or
 * for the player to manually Backup Save / Restore Backup, either of which
 * re-establishes the baseline).
 *
 * `RemoteFingerprint`'s two comparison slots (`headRevisionId`/`md5Checksum`)
 * are named after Google Drive's own metadata fields, since Drive was the
 * first provider and has no single canonical revision id. Dropbox — which
 * does have one (`rev`) — populates only `headRevisionId` and leaves
 * `md5Checksum` null; `isSafeToAutoUpload` doesn't care which provider it's
 * comparing for, it just compares whichever fields are present on both
 * sides.
 */

declare global {
  interface Window {
    // Injected by @capacitor/core at runtime on Android/iOS builds.
    Capacitor?: {
      isNativePlatform?: () => boolean;
    };
    // Injected by configs/desktop/electron/preload.cjs on the Electron build.
    // Declared once here (rather than per-provider file) since TypeScript's
    // declaration merging requires every `declare global` augmentation of
    // the same interface member to have an identical type — see the
    // Electron IPC bridge methods each provider actually calls in
    // google-drive-backup.ts / dropbox-backup.ts.
    pkrOffline?: {
      googleSignIn: () => Promise<string>;
      hasStoredGoogleCredentials: () => Promise<boolean>;
      googleSignOut: () => Promise<boolean>;
      dropboxSignIn: () => Promise<string>;
      hasStoredDropboxCredentials: () => Promise<boolean>;
      dropboxSignOut: () => Promise<boolean>;
    };
  }
}

export function isCapacitor(): boolean {
  return typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
}

export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.pkrOffline;
}

/** The subset of a remote file's metadata used as an anti-overwrite fingerprint. */
export interface RemoteFingerprint {
  id: string;
  headRevisionId: string | null;
  md5Checksum: string | null;
}

/** The fingerprint of the last upload/restore this device performed for a given provider, remembered locally. */
export interface RememberedFingerprint {
  headRevisionId: string | null;
  md5Checksum: string | null;
  syncToken: string | null;
}

/** Matches this module's own local-only sync bookkeeping keys (fingerprints, debounce timestamp, active provider, provider tokens) — never uploaded, never restored. */
export const SYNC_STATE_KEY_PATTERN = /^pkrOfflineSync_/;

/** Minimum time between auto-sync upload attempts, regardless of how often checkpoints fire. */
export const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Pure decision function: is it safe for auto-sync to overwrite the remote
 * backup? Compares this device's remembered fingerprint (from its last
 * successful upload/restore) against the remote file's current fingerprint.
 *
 *  - No remote file exists → safe (nothing to overwrite).
 *  - Remote file exists but nothing is remembered locally → unsafe (this
 *    device has never synced against this account/file — exactly the
 *    "device B never loaded device A's upload" scenario).
 *  - Remote file exists and a fingerprint is remembered → safe only if the
 *    remembered and remote fingerprints still match (nothing else has
 *    written to the remote since this device last synced).
 *
 * Provider-agnostic: works identically for Google Drive (which populates
 * both `headRevisionId` and `md5Checksum`) and Dropbox (which only ever
 * populates `headRevisionId`, with its `rev`).
 */
export function isSafeToAutoUpload(
  remembered: RememberedFingerprint | null,
  remote: RemoteFingerprint | null,
): boolean {
  if (!remote) {
    return true;
  }
  if (!remembered) {
    return false;
  }
  if (remembered.headRevisionId && remote.headRevisionId) {
    return remembered.headRevisionId === remote.headRevisionId;
  }
  if (remembered.md5Checksum && remote.md5Checksum) {
    return remembered.md5Checksum === remote.md5Checksum;
  }
  return false;
}

/** The outcome of a provider's `upload()` call. Conflict is a first-class result, not a thrown error. */
export type UploadOutcome =
  | { status: "uploaded"; fingerprint: RemoteFingerprint; syncToken: string | null }
  | { status: "conflict" };

/**
 * Implemented once per cloud backend (Google Drive, Dropbox, ...). The
 * manager (`#system/offline/backup-manager`) is the only consumer — the game
 * and UI never talk to a provider directly.
 */
export interface BackupProvider {
  /** Stable identifier, used to derive this provider's local storage keys (fingerprint, tokens). */
  readonly id: string;

  /** Plain text only — shown directly in the UI, never paired with a logo. */
  readonly displayName: string;

  /** Whether we currently hold a usable connection from a prior sign-in this session. */
  isAuthenticated(): boolean;

  /** Runs the full interactive sign-in flow for this provider. */
  authenticate(): Promise<void>;

  /** Forgets the current connection (and any persisted credentials, where applicable). */
  signOut(): Promise<void>;

  /**
   * Attempts to silently restore a connection from a previous session,
   * without prompting the user. Safe to call on every screen open. Returns
   * whether it succeeded.
   */
  tryRestoreSession(): Promise<boolean>;

  /** Metadata-only lookup of the existing remote backup file, or null if none exists yet. */
  getRemoteFingerprint(): Promise<RemoteFingerprint | null>;

  /** Downloads the existing remote backup. Throws if none exists. */
  download(): Promise<{ data: Record<string, string>; fingerprint: RemoteFingerprint; syncToken: string | null }>;

  /**
   * Uploads (or overwrites) the single backup file for this provider.
   *
   *  - Without `expectedFingerprint`: unconditional overwrite (the manual
   *    "Backup Save" path — a deliberate player action, always wins).
   *  - With `expectedFingerprint`: conditional — if the provider supports
   *    atomic conditional writes (Dropbox does, via `mode: update` + `rev`),
   *    the write only succeeds if the remote is still at that exact
   *    fingerprint, and a concurrent change resolves to `{status:
   *    "conflict"}` instead of clobbering it or throwing. Providers without
   *    conditional-write support (Google Drive) fall back to relying
   *    entirely on the caller's own pre-upload `isSafeToAutoUpload()` check
   *    and always resolve to `"uploaded"` — see this module's doc comment
   *    for the accepted residual TOCTOU race that implies.
   */
  upload(
    payload: Record<string, string>,
    opts?: { expectedFingerprint?: RemoteFingerprint },
  ): Promise<UploadOutcome>;
}
