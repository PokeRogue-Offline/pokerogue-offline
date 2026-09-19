/**
 * Google Drive backup provider for PokeRogue-Offline. Implements
 * `#system/offline/backup-provider`'s `BackupProvider` interface — see that
 * module for the shared anti-overwrite design doc, and
 * `#system/offline/backup-manager` for the module that actually decides
 * *when* to call this (debounce, dirty flag, payload collection, etc). This
 * file is purely "how to talk to Google Drive."
 *
 * Backs up to the user's hidden Drive "appDataFolder" — the payload itself
 * (which localStorage keys are/aren't included) is entirely the manager's
 * concern, not this provider's.
 *
 * ── Anti-overwrite specifics for Drive ──────────────────────────────────
 *
 * Drive API v3 has no compare-and-swap / conditional write, so `upload()`
 * with `expectedFingerprint` set still always overwrites unconditionally —
 * there is no way to make it atomic on Drive's side. The manager's own
 * `isSafeToAutoUpload()` pre-check (using {@link getRemoteFingerprint}'s
 * `headRevisionId`, falling back to `md5Checksum`) is therefore the *entire*
 * safety net for Drive auto-uploads, and the metadata-check-then-write
 * remains two sequential HTTP calls with a narrow TOCTOU race — see
 * `backup-provider.ts`'s doc comment for why that's an accepted, deliberate
 * residual rather than a bug.
 *
 * Every upload also writes a self-issued `syncToken` inside the JSON payload
 * itself, and it's still returned from {@link upload}/{@link download} so the
 * manager can remember it. As of this generalization it is no longer used as
 * a live runtime fallback for the safety check, though: `isSafeToAutoUpload`
 * is required to be a single *pure*, synchronous function shared across every
 * provider (see `backup-provider.ts`), which rules out an async
 * "fetch-the-file-content-and-compare-syncToken" branch. The original
 * fallback only existed to guard against Drive not populating
 * `headRevisionId`/`md5Checksum` on an appDataFolder file at all, which
 * contradicts Drive API v3's own documented behavior and was already flagged
 * as unverified against a live account — dropping the live fallback trades
 * an unreachable-in-practice edge case for a materially simpler, correct
 * multi-provider safety check. If a real account is ever seen returning
 * neither field, `isSafeToAutoUpload` still fails conservatively (unsafe),
 * it just can't self-heal via `syncToken` the way the original draft hoped
 * to.
 *
 * Token model: on Electron, main.cjs requests offline access and persists a
 * refresh token (encrypted via Electron's safeStorage where available) so
 * the connection survives app restarts — see main.cjs for the full
 * explanation. On Capacitor, the native Google Sign-In SDKs typically
 * persist sign-in state on-device themselves; whether that means no extra
 * work is needed here or whether an explicit "restore previous sign-in"
 * call is required has NOT been verified yet — flagged below.
 *
 * NOTE: This module has not been exercised against a live Drive account or a
 * real device/build yet. The request shapes follow Drive API v3's documented
 * multipart-upload format, but treat this as a solid first draft that needs
 * to be verified end-to-end once wired into an actual build.
 */

import type { BackupProvider, RemoteFingerprint, UploadOutcome } from "#system/offline/backup-provider";
import { isCapacitor, isElectron } from "#system/offline/backup-provider";

const BACKUP_FILE_NAME = "pkroffline-save-backup.json";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

interface UploadResult {
  id: string;
  headRevisionId: string | null;
  md5Checksum: string | null;
  syncToken: string;
}

export class GoogleDriveProvider implements BackupProvider {
  readonly id = "google-drive";
  readonly displayName = "Google Drive";

  private cachedAccessToken: string | null = null;

  isAuthenticated(): boolean {
    return !!this.cachedAccessToken;
  }

  /**
   * Attempts to silently restore a connection from a previous session,
   * without prompting the user. Safe to call on every screen open — on
   * Electron this hits the fast/no-browser-popup path in main.cjs when a
   * stored refresh token exists, and does nothing if one doesn't.
   *
   * On Capacitor: NOT YET IMPLEMENTED. The native SDKs likely handle this
   * automatically or via their own "restore previous sign-in" call, but that
   * hasn't been confirmed against the actual plugin. Always returns false
   * here for now rather than guessing at an API call that might not exist.
   */
  async tryRestoreSession(): Promise<boolean> {
    if (this.cachedAccessToken) {
      return true;
    }

    if (isElectron()) {
      try {
        const hasStored = await window.pkrOffline!.hasStoredGoogleCredentials();
        if (!hasStored) {
          return false;
        }
        this.cachedAccessToken = await window.pkrOffline!.googleSignIn();
        return true;
      } catch (err) {
        console.warn("Silent Google session restore failed:", err);
        return false;
      }
    }

    return false;
  }

  /** Forgets the current connection, on Electron also deleting the stored refresh token. */
  async signOut(): Promise<void> {
    this.cachedAccessToken = null;
    if (isElectron()) {
      await window.pkrOffline!.googleSignOut();
    }
    // Capacitor sign-out not implemented yet — same caveat as tryRestoreSession.
  }

  /** Signs the user into Google, scoped to drive.appdata only, and caches the resulting access token. */
  async authenticate(): Promise<void> {
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
      // The plugin's type for `res.result` is a union of the online/offline
      // response shapes regardless of the `mode: "online"` configured above
      // (only `initialize()` sees that value, not `login()`'s return type),
      // so `accessToken` needs a narrowing cast here even though it's always
      // present at runtime for the online mode this module always uses.
      const token = (res?.result as { accessToken?: { token?: string } } | undefined)?.accessToken?.token;
      if (!token) {
        throw new Error("Google sign-in did not return an access token.");
      }
      this.cachedAccessToken = token;
      return;
    }

    if (isElectron()) {
      const token = await window.pkrOffline!.googleSignIn();
      if (!token) {
        throw new Error("Google sign-in did not return an access token.");
      }
      this.cachedAccessToken = token;
      return;
    }

    throw new Error("Google sign-in is not supported in this build.");
  }

  /** Find the existing backup file inside appDataFolder, if one exists, along with its revision fingerprint. */
  private async findExistingBackupFile(): Promise<RemoteFingerprint | null> {
    const accessToken = this.requireToken();
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

  async getRemoteFingerprint(): Promise<RemoteFingerprint | null> {
    return this.findExistingBackupFile();
  }

  async download(): Promise<{ data: Record<string, string>; fingerprint: RemoteFingerprint; syncToken: string | null }> {
    const accessToken = this.requireToken();
    const existing = await this.findExistingBackupFile();
    if (!existing) {
      throw new Error("No backup found in Google Drive to restore from.");
    }

    const res = await fetch(`${DRIVE_FILES_URL}/${existing.id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new Error(`Drive download failed: ${res.status} ${await res.text()}`);
    }

    const parsed = await res.json();
    const data: Record<string, string> = parsed?.data ?? {};
    const syncToken = typeof parsed?.syncToken === "string" ? parsed.syncToken : null;

    return { data, fingerprint: existing, syncToken };
  }

  /** Shared multipart upload body. */
  private async performUpload(existingId: string | null, payload: Record<string, string>): Promise<UploadResult> {
    const accessToken = this.requireToken();
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
      id: body.id ?? existingId ?? "",
      headRevisionId: body.headRevisionId ?? null,
      md5Checksum: body.md5Checksum ?? null,
      syncToken,
    };
  }

  /**
   * Uploads (or overwrites) the single backup file in the user's Drive
   * appDataFolder. `expectedFingerprint` is accepted for interface
   * conformance but not used to guard the write — Drive API v3 has no
   * conditional-write support, so this always overwrites unconditionally,
   * exactly like today. When `expectedFingerprint` is provided (the
   * auto-sync path), its `id` is reused instead of doing a second metadata
   * lookup the manager's own pre-upload safety check already performed. When
   * it's omitted (the manual "Backup Save" path), the existing file is
   * looked up fresh, matching today's unconditional-overwrite behavior.
   */
  async upload(
    payload: Record<string, string>,
    opts?: { expectedFingerprint?: RemoteFingerprint },
  ): Promise<UploadOutcome> {
    const existingId = opts?.expectedFingerprint
      ? opts.expectedFingerprint.id
      : ((await this.findExistingBackupFile())?.id ?? null);

    const result = await this.performUpload(existingId, payload);
    return {
      status: "uploaded",
      fingerprint: { id: result.id, headRevisionId: result.headRevisionId, md5Checksum: result.md5Checksum },
      syncToken: result.syncToken,
    };
  }

  private requireToken(): string {
    if (!this.cachedAccessToken) {
      throw new Error("Not signed in — call authenticate() first.");
    }
    return this.cachedAccessToken;
  }
}
