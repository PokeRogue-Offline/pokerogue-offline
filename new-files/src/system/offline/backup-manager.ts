/**
 * The single module the game and UI talk to for cloud backups. Routes
 * `backupSave()` / `restoreFromBackup()` / `autoSyncCheckpoint()` to
 * whichever {@link BackupProvider} is currently active, and owns everything
 * provider-agnostic: which provider is selected, the debounce/dirty/safety
 * gating for auto-sync, payload collection, and per-provider fingerprint
 * storage.
 *
 * Adding a third provider later only requires a new class implementing
 * `BackupProvider` (see `backup-provider.ts`) and one line in {@link providers}
 * below — everything in this file, and the UI selector wired against it,
 * works for any number of providers already.
 */

import type { BackupProvider, RememberedFingerprint } from "#system/offline/backup-provider";
import { AUTO_SYNC_MIN_INTERVAL_MS, isSafeToAutoUpload, SYNC_STATE_KEY_PATTERN } from "#system/offline/backup-provider";
import { DropboxProvider } from "#system/offline/dropbox-backup";
import { GoogleDriveProvider } from "#system/offline/google-drive-backup";

// Matches sessionData_<user>, sessionData1_<user> ... sessionData4_<user>.
const SESSION_KEY_PATTERN = /^sessionData\d*_/;

const ACTIVE_PROVIDER_KEY = "pkrOfflineSync_activeProvider";
const LAST_ATTEMPT_KEY = "pkrOfflineSync_lastAttempt";
const RESTORE_PROMPT_OFFERED_KEY = "pkrOfflineSync_restorePromptOffered";

/** First provider ever shipped — kept as the default for existing users, and the one whose fingerprint key stays unsuffixed (no migration). */
const DEFAULT_PROVIDER_ID = "google-drive";

let providers: BackupProvider[] = [new GoogleDriveProvider(), new DropboxProvider()];

/**
 * Test-only seam: substitutes the registered provider list with fakes so
 * backup-manager's routing/gating logic can be unit-tested without making
 * real HTTP calls through GoogleDriveProvider/DropboxProvider. Never called
 * by game or UI code.
 */
export function __setProvidersForTest(testProviders: BackupProvider[]): void {
  providers = testProviders;
}

/**
 * True once a local save has happened since the last successful upload (auto
 * or manual) — set by {@link autoSyncCheckpoint} every time it's invoked,
 * cleared only after a successful upload/restore. In-memory only: it only
 * needs to survive within one running session, and is intentionally not
 * per-provider — switching providers mid-session doesn't invent new local
 * changes to upload.
 */
let isDirty = false;

/** Every registered provider, in selector order. */
export function getProviders(): readonly BackupProvider[] {
  return providers;
}

export function getActiveProviderId(): string {
  return localStorage.getItem(ACTIVE_PROVIDER_KEY) ?? DEFAULT_PROVIDER_ID;
}

export function getActiveProvider(): BackupProvider {
  const id = getActiveProviderId();
  // Falls back to the first registered provider (Google Drive, in
  // production) rather than hardcoding a lookup for DEFAULT_PROVIDER_ID
  // specifically — covers a stored id that no longer matches any
  // registered provider (e.g. a removed third-party provider) without
  // assuming anything about which providers exist.
  return providers.find(p => p.id === id) ?? providers[0];
}

/**
 * Switches the active provider. Purely a local preference change — never
 * makes a network call, never triggers a download. The newly-active
 * provider's own authenticated state (if any) and remembered fingerprint are
 * untouched, so switching back later picks up right where it left off.
 */
export function switchProvider(id: string): void {
  localStorage.setItem(ACTIVE_PROVIDER_KEY, id);
}

function getFingerprintKey(providerId: string): string {
  return providerId === DEFAULT_PROVIDER_ID ? "pkrOfflineSync_fingerprint" : `pkrOfflineSync_${providerId}_fingerprint`;
}

/** Forgets a single provider's stored credentials and remembered fingerprint. */
async function forgetProvider(provider: BackupProvider): Promise<void> {
  await provider.signOut();
  localStorage.removeItem(getFingerprintKey(provider.id));
}

/**
 * Explicit "Disconnect Account" action: forgets the active provider's stored
 * credentials and remembered fingerprint, so a later reconnect always goes
 * through a full interactive sign-in (e.g. to pick up permission changes on
 * the OAuth app, rather than silently reusing a stale cached token).
 */
export async function disconnectActiveProvider(): Promise<void> {
  await forgetProvider(getActiveProvider());
  localStorage.removeItem(RESTORE_PROMPT_OFFERED_KEY);
}

/**
 * Runs the active provider's interactive sign-in flow, and on success forgets
 * every *other* registered provider's stored credentials/fingerprint — so
 * successfully connecting a new provider always leaves exactly one provider
 * authenticated, never a stale leftover connection to whichever provider was
 * used previously.
 */
export async function authenticateActiveProvider(): Promise<void> {
  const active = getActiveProvider();
  await active.authenticate();
  await Promise.all(providers.filter(p => p.id !== active.id).map(p => forgetProvider(p)));
  localStorage.removeItem(RESTORE_PROMPT_OFFERED_KEY);
}

/**
 * Whether the "a backup was found, restore it?" prompt has already been
 * offered for the current connection. Persisted (not in-memory) because the
 * prompt's own "yes" path reloads the page — an in-memory flag would forget
 * it was already offered and re-ask on the very next silent
 * `tryRestoreSession()` reconnect. Cleared only by a genuinely new
 * connection ({@link authenticateActiveProvider}, which covers both a fresh
 * sign-in and switching to another provider) or an explicit
 * {@link disconnectActiveProvider}, so a silent reconnect of the *same*
 * already-known connection never re-triggers it.
 */
export function hasOfferedRestorePrompt(): boolean {
  return localStorage.getItem(RESTORE_PROMPT_OFFERED_KEY) === "1";
}

/** Marks the restore prompt as offered for the current connection — see {@link hasOfferedRestorePrompt}. */
export function markRestorePromptOffered(): void {
  localStorage.setItem(RESTORE_PROMPT_OFFERED_KEY, "1");
}

function getFingerprint(providerId: string): RememberedFingerprint | null {
  try {
    const raw = localStorage.getItem(getFingerprintKey(providerId));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch (err) {
    console.error("backup-manager: failed to read sync fingerprint", err);
    return null;
  }
}

function setFingerprint(providerId: string, fingerprint: RememberedFingerprint): void {
  localStorage.setItem(getFingerprintKey(providerId), JSON.stringify(fingerprint));
}

function getLastAutoSyncAttempt(): number {
  const raw = localStorage.getItem(LAST_ATTEMPT_KEY);
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function setLastAutoSyncAttempt(ms: number): void {
  localStorage.setItem(LAST_ATTEMPT_KEY, String(ms));
}

/** Reads the persisted "Include Current Run" toggle directly from the shared settings blob. */
function includeCurrentRunEnabled(): boolean {
  try {
    const raw = localStorage.getItem("settings");
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw);
    return parsed?.offline?.includeCurrentRun === true;
  } catch (err) {
    console.error("backup-manager: failed to read Include Current Run setting", err);
    return false;
  }
}

/**
 * Collect every localStorage key/value — session keys included only if the
 * "Include Current Run" toggle (Offline settings tab) is on. This module's
 * own local-only sync bookkeeping (`pkrOfflineSync_*`) is always excluded —
 * it describes this device's relationship to the active provider, not save
 * data, and must never be uploaded or restored. Provider-agnostic: every
 * provider uploads/downloads exactly this same payload shape.
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

/**
 * Uploads (or overwrites) the backup on the active provider, unconditionally
 * — this is the forced, manual "Backup Save" path, and always wins
 * regardless of what's currently remote, since it's a deliberate player
 * action. Throws if the active provider isn't authenticated.
 */
export async function backupSave(): Promise<void> {
  const provider = getActiveProvider();
  const outcome = await provider.upload(collectBackupPayload());
  if (outcome.status !== "uploaded") {
    // backupSave() never passes expectedFingerprint, so every provider's
    // upload() is unconditional here — a "conflict" outcome would mean a
    // provider implementation bug, not a real concurrent-write scenario.
    throw new Error(`${provider.displayName}: unexpected conflict on an unconditional backup save.`);
  }
  setFingerprint(provider.id, {
    headRevisionId: outcome.fingerprint.headRevisionId,
    md5Checksum: outcome.fingerprint.md5Checksum,
    syncToken: outcome.syncToken,
  });
  isDirty = false;
}

/**
 * Downloads and restores the active provider's existing backup, overwriting
 * every key it contains directly into localStorage (this module's own
 * `pkrOfflineSync_*` bookkeeping keys are skipped defensively). The caller is
 * still expected to force a reload afterward so the game actually picks up
 * the restored data. Manual-only — never called automatically.
 *
 * After a successful restore, the active provider's remembered fingerprint is
 * reset to match the just-downloaded file exactly — local now mirrors
 * remote, so there's nothing new to auto-upload until something actually
 * changes. Throws if there's no existing backup to restore from.
 */
export async function restoreFromBackup(): Promise<void> {
  const provider = getActiveProvider();
  const { data, fingerprint, syncToken } = await provider.download();

  for (const [key, value] of Object.entries(data)) {
    if (SYNC_STATE_KEY_PATTERN.test(key)) {
      continue;
    }
    localStorage.setItem(key, value);
  }

  setFingerprint(provider.id, {
    headRevisionId: fingerprint.headRevisionId,
    md5Checksum: fingerprint.md5Checksum,
    syncToken,
  });
  isDirty = false;
}

/**
 * Called by the patched wave-advance hook (patches/all/node/auto-drive-sync.js)
 * every 5 waves — the same cadence the online game itself checkpoints on.
 * Uploads only if: the active provider is authenticated, the minimum
 * debounce interval has elapsed since the last attempt, there's something
 * dirty to upload, AND the anti-overwrite safety check passes. Never throws
 * — any failure is logged and swallowed, so a network hiccup can never
 * interrupt gameplay. Always fire-and-forget from the caller's perspective
 * (`void autoSyncCheckpoint()`).
 */
export async function autoSyncCheckpoint(): Promise<void> {
  isDirty = true;

  const provider = getActiveProvider();

  if (!provider.isAuthenticated()) {
    return;
  }
  if (Date.now() - getLastAutoSyncAttempt() < AUTO_SYNC_MIN_INTERVAL_MS) {
    return;
  }
  if (!isDirty) {
    return;
  }

  try {
    const remote = await provider.getRemoteFingerprint();
    const remembered = getFingerprint(provider.id);

    if (!isSafeToAutoUpload(remembered, remote)) {
      // A remote write exists that this device doesn't know about — skip
      // silently rather than clobber it. Still record the attempt so a busy
      // stretch of checkpoints doesn't retry the (cheap, but not free)
      // metadata lookup every single wave; the next checkpoint after the
      // debounce window will re-check.
      setLastAutoSyncAttempt(Date.now());
      return;
    }

    // `exactOptionalPropertyTypes` forbids explicitly assigning `undefined`
    // to an optional property, so the `{ expectedFingerprint }` object is
    // only constructed when there's an actual remote fingerprint to attach.
    const outcome = remote
      ? await provider.upload(collectBackupPayload(), { expectedFingerprint: remote })
      : await provider.upload(collectBackupPayload());

    if (outcome.status === "conflict") {
      // Only reachable for providers with real conditional-write support
      // (Dropbox): the metadata pre-check above passed, but a concurrent
      // write landed in the narrow window between that check and this
      // upload. The provider's atomic conditional write caught it where the
      // pre-check alone couldn't — treat exactly like the safety check
      // having failed.
      setLastAutoSyncAttempt(Date.now());
      return;
    }

    setFingerprint(provider.id, {
      headRevisionId: outcome.fingerprint.headRevisionId,
      md5Checksum: outcome.fingerprint.md5Checksum,
      syncToken: outcome.syncToken,
    });
    setLastAutoSyncAttempt(Date.now());
    isDirty = false;
  } catch (err) {
    console.warn("pkr-offline: auto-sync checkpoint failed, will retry at the next checkpoint:", err);
  }
}

/**
 * Downloads the active provider's existing backup (if any) purely to read
 * the embedded save's last-played time — doesn't write anything to
 * localStorage. Used by the "Last Backup Played" info row and by the
 * sign-in restore prompt (to decide whether there's anything worth offering
 * to restore). Returns null if there's no backup yet, rather than throwing.
 */
export async function getRemoteLastPlayed(): Promise<string | null> {
  const provider = getActiveProvider();

  const remote = await provider.getRemoteFingerprint();
  if (!remote) {
    return null;
  }

  const { data } = await provider.download();
  const rawSystemData = data["data_Guest"];
  if (!rawSystemData) {
    return null;
  }

  try {
    const json = decodeURIComponent(atob(rawSystemData));
    const saveData = JSON.parse(json);
    return saveData?.timestamp ? new Date(saveData.timestamp).toLocaleString() : null;
  } catch (err) {
    console.error("backup-manager: failed to parse embedded save data from backup", err);
    return null;
  }
}
