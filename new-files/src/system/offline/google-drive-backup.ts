/**
 * Cross-platform Google Drive backup helper for PokeRogue-Offline.
 *
 * Backs up every localStorage key EXCEPT in-progress session data
 * (`sessionData`, `sessionData1`..`sessionData4`, per-user) and this module's
 * own local-only sync bookkeeping (`pkrOfflineSync_*`, see below) to the
 * user's hidden Drive "appDataFolder" — UNLESS the "Include Current Run"
 * setting (Offline tab) is turned on, in which case session keys are
 * included too.
 *
 * Two upload paths:
 *  - {@link backupSave} — manual, forced, unconditional. Always overwrites
 *    the remote file, since it's a deliberate player action ("Backup Save").
 *  - {@link autoSyncCheckpoint} — automatic, called by a patched wave-advance
 *    hook every 5 waves (matching the online game's own server-checkpoint
 *    cadence, see patches/all/node/auto-drive-sync.js). Gated by a dirty
 *    flag, a debounce interval, AND an anti-overwrite safety check (below) —
 *    never forces an overwrite.
 *
 * Restore ({@link restoreFromBackup}) downloads the existing backup file and
 * writes every key it contains straight back into localStorage — including
 * session keys, if the backup happens to have them (i.e. it was made with
 * "Include Current Run" on). Restore, like backup-save, remains entirely
 * manual-only — auto-sync only ever pushes local data up, it never pulls
 * remote data down on its own.
 *
 * ── Anti-overwrite design ───────────────────────────────────────────────
 *
 * The problem: the same Google account can be signed into multiple devices,
 * each with its own local save. Device clocks aren't trustworthy or synced
 * across devices, and Drive API v3 has no compare-and-swap / conditional
 * write, so the "is it safe to overwrite" check and the upload itself can't
 * be made atomic. Without a safeguard, an older device could silently
 * overwrite a newer device's uploaded progress the moment it hits its own
 * 5-wave checkpoint, without the player ever deciding that should happen.
 *
 * The fix: an ETag-style optimistic-concurrency fingerprint, using Drive's
 * own per-file revision identity (`headRevisionId`, falling back to
 * `md5Checksum`) instead of any wall-clock comparison. Every successful
 * upload or restore remembers that fingerprint locally
 * (`pkrOfflineSync_fingerprint`, deliberately excluded from the backup
 * payload itself via `SYNC_STATE_KEY_PATTERN` — this is device-local
 * bookkeeping, not save data). Before an AUTO upload, the remote's current
 * fingerprint is re-checked (as part of the same metadata lookup
 * {@link findExistingBackupFile} already makes before every upload, so this
 * costs no extra round-trip): if it still matches what this device
 * remembers, nothing else has written to Drive since this device last
 * synced, so it's safe to overwrite. If it differs — or nothing is
 * remembered yet, e.g. this device has never synced against this account —
 * a remote write this device doesn't know about exists, and the auto-upload
 * is silently skipped (no dialog, no retry storm — just wait for the next
 * checkpoint, or for the player to manually Backup Save / Restore Backup,
 * either of which re-establishes the baseline).
 *
 * As a zero-cost defense-in-depth fallback (in case Drive were ever to not
 * populate `headRevisionId`/`md5Checksum` for an appDataFolder file, which
 * contradicts Drive API v3's own documented behavior for files with opaque
 * binary content, but isn't verifiable against a live account from this
 * environment), every upload also writes a self-issued `syncToken` inside
 * the JSON payload itself. It's only ever read back via an extra content
 * fetch if the metadata fields are genuinely absent on both sides.
 *
 * This is NOT airtight: the metadata check and the write are still two
 * sequential HTTP calls, so a narrow TOCTOU race remains — two devices could
 * both pass the safety check and then both write before either one's
 * fingerprint updates. This is an accepted, deliberate residual: auto-sync
 * is debounced to infrequent, single, non-concurrent writes (not a hot
 * loop), the collision requires the same player actively progressing on two
 * devices at the exact same moment, and the failure mode is still manually
 * recoverable via Backup Save / Restore Backup. Drive API v3 offers no way
 * to close this window entirely.
 *
 * Manual save/restore are intentionally exempt from all of the above: manual
 * save always overwrites unconditionally (deliberate player action), and
 * manual restore is unaffected since it never writes to Drive.
 *
 * Token model: on Electron, main.cjs now requests offline access and
 * persists a refresh token (encrypted via Electron's safeStorage where
 * available) so the connection survives app restarts — see main.cjs for the
 * full explanation of why the original online-only flow lost the connection
 * every time the app reopened. On Capacitor, the native Google Sign-In SDKs
 * typically persist sign-in state on-device themselves; whether that means
 * no extra work is needed here or whether an explicit "restore previous
 * sign-in" call is required has NOT been verified yet — flagged below.
 *
 * NOTE: This module has not been exercised against a live Drive account or a
 * real device/build yet. The request shapes follow Drive API v3's documented
 * multipart-upload format, but treat this as a solid first draft that needs
 * to be verified end-to-end once wired into an actual build.
 */

import { SettingKeys } from "#system/settings";

const BACKUP_FILE_NAME = "pkroffline-save-backup.json";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// Matches sessionData_<user>, sessionData1_<user> ... sessionData4_<user>.
const SESSION_KEY_PATTERN = /^sessionData\d*_/;

// Matches this module's own local-only sync bookkeeping keys (fingerprint,
// debounce timestamp) — never uploaded, never restored.
const SYNC_STATE_KEY_PATTERN = /^pkrOfflineSync_/;

const FINGERPRINT_KEY = "pkrOfflineSync_fingerprint";
const LAST_ATTEMPT_KEY = "pkrOfflineSync_lastAttempt";

/** Minimum time between auto-sync upload attempts, regardless of how often checkpoints fire. */
const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

declare global {
  interface Window {
    // Injected by @capacitor/core at runtime on Android/iOS builds.
    Capacitor?: {
      isNativePlatform?: () => boolean;
    };
    // Injected by configs/desktop/electron/preload.cjs on the Electron build.
    pkrOffline?: {
      googleSignIn: () => Promise<string>;
      hasStoredGoogleCredentials: () => Promise<boolean>;
      googleSignOut: () => Promise<boolean>;
    };
  }
}

function isCapacitor(): boolean {
  return typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
}

function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.pkrOffline;
}

let cachedAccessToken: string | null = null;

/**
 * True once a local save has happened since the last successful upload (auto
 * or manual) — set by {@link autoSyncCheckpoint} every time it's invoked
 * (i.e. every wave-hook checkpoint, since that only fires after a successful
 * local save), cleared only after a successful upload/restore. In-memory
 * only: it only needs to survive within one running session.
 */
let isDirty = false;

/** Whether we currently hold an access token from a prior sign-in this session. */
export function isSignedIn(): boolean {
  return !!cachedAccessToken;
}

/**
 * Attempts to silently restore a connection from a previous session, without
 * prompting the user. Safe to call on every screen open — on Electron this
 * hits the fast/no-browser-popup path in main.cjs when a stored refresh
 * token exists, and does nothing if one doesn't. Returns whether it
 * succeeded.
 *
 * On Capacitor: NOT YET IMPLEMENTED. The native SDKs likely handle this
 * automatically or via their own "restore previous sign-in" call, but that
 * hasn't been confirmed against the actual plugin — see the plan doc's list
 * of unverified items. Always returns false here for now rather than
 * guessing at an API call that might not exist.
 */
export async function tryRestoreSession(): Promise<boolean> {
  if (cachedAccessToken) {
    return true;
  }

  if (isElectron()) {
    try {
      const hasStored = await window.pkrOffline!.hasStoredGoogleCredentials();
      if (!hasStored) {
        return false;
      }
      cachedAccessToken = await window.pkrOffline!.googleSignIn();
      return true;
    } catch (err) {
      console.warn("Silent Google session restore failed:", err);
      return false;
    }
  }

  return false;
}

/** Forgets the current connection, on Electron also deleting the stored refresh token. */
export async function signOut(): Promise<void> {
  cachedAccessToken = null;
  if (isElectron()) {
    await window.pkrOffline!.googleSignOut();
  }
  // Capacitor sign-out not implemented yet — same caveat as tryRestoreSession.
}

/**
 * Signs the user into Google, scoped to drive.appdata only, and caches the
 * resulting access token for use by {@link backupSave}.
 */
export async function signIn(): Promise<string> {
  if (isCapacitor()) {
    // @capgo/capacitor-social-login — NOT @codetrix-studio/capacitor-google-auth.
    // The codetrix plugin is effectively unmaintained (peer dep capped at
    // Capacitor 6; this project pins Capacitor 8), so this fork is used
    // instead. API shape is meaningfully different — see the plan doc and
    // https://capgo.app/docs/plugins/social-login/google/android/
    const { SocialLogin } = await import("@capgo/capacitor-social-login");
    await SocialLogin.initialize({
      google: {
        // webClientId is intentionally used here even though we're on a
        // native platform — see capacitor.config.json comments; this is a
        // "Web application" type client used purely as the token audience.
        webClientId: "856587427302-iffda5uuavbg9ft4eo4f5c93fmu46kqg.apps.googleusercontent.com",
        // REQUIRED on iOS specifically — without this, SocialLogin.login()
        // throws "No provider was initialized" on iOS even though the exact
        // same call works fine on Android with only webClientId set. Harmless
        // to include on Android too, so it's set unconditionally here rather
        // than branching on platform.
        //
        // This value is DIFFERENT for the prod (xyz.scooom.pkr) vs dev
        // (xyz.scooom.pkrdev) iOS builds, since Google's iOS OAuth clients are
        // bundle-ID-locked — substituted at build time via sed, sourced from
        // GOOGLE_IOS_CLIENT_ID / GOOGLE_IOS_DEV_CLIENT_ID secrets. Android
        // ignores this field entirely, so it gets the prod value there too —
        // doesn't matter functionally, just keeps one substitution convention.
        iOSClientId: "IOS_CLIENT_ID_PLACEHOLDER",
        iOSServerClientId: "856587427302-iffda5uuavbg9ft4eo4f5c93fmu46kqg.apps.googleusercontent.com",
        mode: "online", // plain access token, not the server-auth-code/offline flow
      },
    });
    const res = await SocialLogin.login({
      provider: "google",
      options: { scopes: ["https://www.googleapis.com/auth/drive.appdata"] },
    });
    const token = res?.result?.accessToken?.token;
    if (!token) {
      throw new Error("Google sign-in did not return an access token.");
    }
    cachedAccessToken = token;
    return token;
  }

  if (isElectron()) {
    const token = await window.pkrOffline!.googleSignIn();
    if (!token) {
      throw new Error("Google sign-in did not return an access token.");
    }
    cachedAccessToken = token;
    return token;
  }

  throw new Error("Google sign-in is not supported in this build.");
}

/** Reads the persisted "Include Current Run" toggle directly from the shared settings blob. */
function includeCurrentRunEnabled(): boolean {
  try {
    const raw = localStorage.getItem("settings");
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw);
    return parsed?.[SettingKeys.Offline_Include_Current_Run] === 1;
  } catch (err) {
    console.error("google-drive-backup: failed to read Include Current Run setting", err);
    return false;
  }
}

/**
 * Collect every localStorage key/value — session keys included only if the
 * "Include Current Run" toggle (Offline settings tab) is on. This module's
 * own local-only sync bookkeeping (`pkrOfflineSync_*`) is always excluded —
 * it describes this device's relationship to Drive, not save data, and must
 * never be uploaded or restored.
 */
function collectBackupPayload(): Record<string, string> {
  const includeSession = includeCurrentRunEnabled();
  const payload: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) {
      continue;
    }
    if (!includeSession && SESSION_KEY_PATTERN.test(key)) {
      continue;
    }
    if (SYNC_STATE_KEY_PATTERN.test(key)) {
      continue;
    }
    const value = localStorage.getItem(key);
    if (value !== null) {
      payload[key] = value;
    }
  }
  return payload;
}

/** The subset of Drive file metadata used as an anti-overwrite fingerprint. */
interface DriveFileInfo {
  id: string;
  headRevisionId: string | null;
  md5Checksum: string | null;
}

/** The fingerprint of the last upload/restore this device performed, remembered locally. */
interface SyncFingerprint {
  headRevisionId: string | null;
  md5Checksum: string | null;
  syncToken: string | null;
}

/** Find the existing backup file inside appDataFolder, if one exists, along with its revision fingerprint. */
async function findExistingBackupFile(accessToken: string): Promise<DriveFileInfo | null> {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name = '${BACKUP_FILE_NAME}'`,
    fields: "files(id, modifiedTime, headRevisionId, md5Checksum)",
  });

  const res = await fetch(`${DRIVE_FILES_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Drive file lookup failed: ${res.status}`);
  }

  const body = await res.json();
  const file = body.files?.[0];
  if (!file) {
    return null;
  }
  return {
    id: file.id,
    headRevisionId: file.headRevisionId ?? null,
    md5Checksum: file.md5Checksum ?? null,
  };
}

function getFingerprint(): SyncFingerprint | null {
  try {
    const raw = localStorage.getItem(FINGERPRINT_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch (err) {
    console.error("google-drive-backup: failed to read sync fingerprint", err);
    return null;
  }
}

function setFingerprint(fingerprint: SyncFingerprint): void {
  localStorage.setItem(FINGERPRINT_KEY, JSON.stringify(fingerprint));
}

function getLastAutoSyncAttempt(): number {
  const raw = localStorage.getItem(LAST_ATTEMPT_KEY);
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function setLastAutoSyncAttempt(ms: number): void {
  localStorage.setItem(LAST_ATTEMPT_KEY, String(ms));
}

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
 *    written to Drive since this device last synced).
 *
 * Deliberately does NOT attempt the `syncToken` content-fetch fallback —
 * that requires a network call and is handled by the async wrapper
 * {@link resolveAutoUploadSafety} around this function instead, so this stays
 * synchronous and easy to unit test.
 */
export function isSafeToAutoUpload(remembered: SyncFingerprint | null, remote: DriveFileInfo | null): boolean {
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

/** Downloads the remote backup's content purely to read its embedded `syncToken` field. */
async function fetchRemoteSyncToken(accessToken: string, fileId: string): Promise<string | null> {
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    return null;
  }
  const parsed = await res.json();
  return typeof parsed?.syncToken === "string" ? parsed.syncToken : null;
}

/**
 * Wraps {@link isSafeToAutoUpload} with the `syncToken` content-fetch
 * fallback for the (unexpected, per Drive API v3's documented behavior)
 * case where the remote file has neither `headRevisionId` nor
 * `md5Checksum` populated. Only reachable in that case — the common path
 * never makes an extra network call.
 */
async function resolveAutoUploadSafety(
  accessToken: string,
  remembered: SyncFingerprint | null,
  remote: DriveFileInfo | null,
): Promise<boolean> {
  if (!remote || !remembered) {
    return isSafeToAutoUpload(remembered, remote);
  }
  const hasComparableMetadata =
    !!(remembered.headRevisionId && remote.headRevisionId) || !!(remembered.md5Checksum && remote.md5Checksum);
  if (hasComparableMetadata) {
    return isSafeToAutoUpload(remembered, remote);
  }
  if (remembered.syncToken) {
    const remoteSyncToken = await fetchRemoteSyncToken(accessToken, remote.id);
    if (remoteSyncToken) {
      return remembered.syncToken === remoteSyncToken;
    }
  }
  return false;
}

interface UploadResult {
  madeAt: string;
  headRevisionId: string | null;
  md5Checksum: string | null;
  syncToken: string;
}

/** Shared multipart upload body, used by both the forced manual path and the gated auto path. */
async function performUpload(accessToken: string, existingId: string | null): Promise<UploadResult> {
  const payload = collectBackupPayload();
  const madeAt = new Date().toISOString();
  const syncToken = crypto.randomUUID();
  const fileContent = JSON.stringify({ backedUpAt: madeAt, syncToken, data: payload });

  const metadata = existingId ? { name: BACKUP_FILE_NAME } : { name: BACKUP_FILE_NAME, parents: ["appDataFolder"] };

  const boundary = "pkroffline-backup-boundary";
  const multipartBody =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: application/json\r\n\r\n" +
    `${fileContent}\r\n` +
    `--${boundary}--`;

  const params = new URLSearchParams({ uploadType: "multipart", fields: "id,headRevisionId,md5Checksum" });
  const url = existingId
    ? `${DRIVE_UPLOAD_URL}/${existingId}?${params.toString()}`
    : `${DRIVE_UPLOAD_URL}?${params.toString()}`;

  const res = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!res.ok) {
    throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  return {
    madeAt,
    headRevisionId: body.headRevisionId ?? null,
    md5Checksum: body.md5Checksum ?? null,
    syncToken,
  };
}

/**
 * Uploads (or overwrites) the single backup file in the user's Drive
 * appDataFolder, unconditionally — this is the forced, manual "Backup Save"
 * path, and always wins regardless of what's currently on Drive, since it's
 * a deliberate player action. Returns the ISO timestamp the backup was made
 * at.
 */
export async function backupSave(): Promise<string> {
  if (!cachedAccessToken) {
    throw new Error("Not signed in — call signIn() first.");
  }

  const existing = await findExistingBackupFile(cachedAccessToken);
  const result = await performUpload(cachedAccessToken, existing?.id ?? null);

  setFingerprint({
    headRevisionId: result.headRevisionId,
    md5Checksum: result.md5Checksum,
    syncToken: result.syncToken,
  });
  isDirty = false;

  return result.madeAt;
}

/**
 * Called by the patched wave-advance hook (patches/all/node/auto-drive-sync.js)
 * every 5 waves — the same cadence the online game itself checkpoints on.
 * Uploads only if: signed in, the minimum debounce interval has elapsed
 * since the last attempt, there's something dirty to upload, AND the
 * anti-overwrite safety check passes. Never throws — any failure is logged
 * and swallowed, so a Drive hiccup can never interrupt gameplay. Always
 * fire-and-forget from the caller's perspective (`void autoSyncCheckpoint()`).
 */
export async function autoSyncCheckpoint(): Promise<void> {
  isDirty = true;

  if (!cachedAccessToken) {
    return;
  }
  if (Date.now() - getLastAutoSyncAttempt() < AUTO_SYNC_MIN_INTERVAL_MS) {
    return;
  }
  if (!isDirty) {
    return;
  }

  try {
    const remote = await findExistingBackupFile(cachedAccessToken);
    const remembered = getFingerprint();

    const safe = await resolveAutoUploadSafety(cachedAccessToken, remembered, remote);
    if (!safe) {
      // A remote write exists that this device doesn't know about — skip
      // silently rather than clobber it. Still record the attempt so a busy
      // stretch of checkpoints doesn't retry the (cheap, but not free)
      // metadata lookup every single wave; the next checkpoint after the
      // debounce window will re-check.
      setLastAutoSyncAttempt(Date.now());
      return;
    }

    const result = await performUpload(cachedAccessToken, remote?.id ?? null);
    setFingerprint({
      headRevisionId: result.headRevisionId,
      md5Checksum: result.md5Checksum,
      syncToken: result.syncToken,
    });
    setLastAutoSyncAttempt(Date.now());
    isDirty = false;
  } catch (err) {
    console.warn("pkr-offline: auto-sync checkpoint failed, will retry at the next checkpoint:", err);
  }
}

/**
 * Downloads and restores the existing Drive backup, overwriting every key it
 * contains directly into localStorage. Whether that includes session keys
 * depends entirely on whether the backup was made with "Include Current
 * Run" on — this function doesn't special-case it either way, it just
 * writes back whatever the file actually has (this module's own
 * `pkrOfflineSync_*` bookkeeping keys are skipped defensively, in case an
 * older backup ever contained any). The caller is still expected to force a
 * reload afterward so the game actually picks up the restored data, since
 * most of it (save data, unlocks, dex) is only ever read once at boot.
 *
 * After a successful restore, this device's remembered fingerprint is reset
 * to match the just-downloaded file exactly — local now mirrors remote, so
 * there's nothing new to auto-upload until something actually changes.
 *
 * Throws if there's no existing backup to restore from.
 */
export async function restoreFromBackup(): Promise<void> {
  if (!cachedAccessToken) {
    throw new Error("Not signed in — call signIn() first.");
  }

  const existing = await findExistingBackupFile(cachedAccessToken);
  if (!existing) {
    throw new Error("No backup found in Google Drive to restore from.");
  }

  const res = await fetch(`${DRIVE_FILES_URL}/${existing.id}?alt=media`, {
    headers: { Authorization: `Bearer ${cachedAccessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Drive download failed: ${res.status} ${await res.text()}`);
  }

  const parsed = await res.json();
  const data: Record<string, string> = parsed?.data ?? {};

  for (const [key, value] of Object.entries(data)) {
    if (SYNC_STATE_KEY_PATTERN.test(key)) {
      continue;
    }
    localStorage.setItem(key, value);
  }

  setFingerprint({
    headRevisionId: existing.headRevisionId,
    md5Checksum: existing.md5Checksum,
    syncToken: typeof parsed?.syncToken === "string" ? parsed.syncToken : null,
  });
  isDirty = false;
}

/**
 * Downloads the existing Drive backup (if any) purely to read the embedded
 * save's last-played time — doesn't write anything to localStorage. Used by
 * the "Drive Last Played" row, which shows the backup's save time rather
 * than the local one, and only ever once actually connected.
 *
 * Returns null if there's no backup yet, rather than throwing, since "no
 * backup exists" is an expected, displayable state, not an error.
 */
export async function getRemoteLastPlayed(): Promise<string | null> {
  if (!cachedAccessToken) {
    throw new Error("Not signed in — call signIn() first.");
  }

  const existing = await findExistingBackupFile(cachedAccessToken);
  if (!existing) {
    return null;
  }

  const res = await fetch(`${DRIVE_FILES_URL}/${existing.id}?alt=media`, {
    headers: { Authorization: `Bearer ${cachedAccessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Drive download failed: ${res.status} ${await res.text()}`);
  }

  const parsed = await res.json();
  const data: Record<string, string> = parsed?.data ?? {};
  const rawSystemData = data["data_Guest"];
  if (!rawSystemData) {
    return null;
  }

  try {
    const json = decodeURIComponent(atob(rawSystemData));
    const saveData = JSON.parse(json);
    return saveData?.timestamp ? new Date(saveData.timestamp).toLocaleString() : null;
  } catch (err) {
    console.error("google-drive-backup: failed to parse embedded save data from backup", err);
    return null;
  }
}
