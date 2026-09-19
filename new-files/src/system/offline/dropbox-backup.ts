/**
 * Dropbox backup provider for PokeRogue-Offline. Implements
 * `#system/offline/backup-provider`'s `BackupProvider` interface — see that
 * module for the shared anti-overwrite design doc, and
 * `#system/offline/backup-manager` for the module that decides *when* to
 * call this. This file is purely "how to talk to Dropbox."
 *
 * The app is registered with "App folder" access, so every path here is
 * relative to that folder — there's no `parents`/`spaces` concept to worry
 * about the way Drive's appDataFolder needed.
 *
 * ── Anti-overwrite specifics for Dropbox ────────────────────────────────
 *
 * Unlike Drive, Dropbox's `files/upload` DOES support a real conditional
 * write: passing `mode: {".tag": "update", "update": <rev>}` only succeeds
 * if the file is still at exactly that `rev`; a concurrent write in between
 * resolves to a 409 `path/conflict` response, mapped here to
 * `{status: "conflict"}`. That makes Dropbox's auto-upload genuinely atomic
 * on top of the manager's own `isSafeToAutoUpload()` pre-check — the narrow
 * TOCTOU window Drive can't close is closed here by the provider itself. See
 * `upload()`'s conflict-detection predicate for the one piece of this file
 * that most needs confirming against a real account (the exact 409 error
 * body shape).
 *
 * ── Auth ─────────────────────────────────────────────────────────────────
 *
 * OAuth 2 + PKCE, no client secret (public client), `token_access_type=
 * offline` for a refresh token. Dropbox, unlike Google, does NOT support a
 * variable/wildcard loopback port for a desktop redirect URI — it must match
 * a value pre-registered in the Dropbox App Console exactly, port included.
 *
 * Dev builds use an entirely separate Dropbox app (own DROPBOX_APP_KEY, own
 * redirect URI registrations) from prod, same split Google's iOS client
 * already has — see each build-*.yml workflow's "Inject Dropbox App Key"
 * step for exactly which secret feeds which build.
 *
 *  - Electron: main.cjs runs the interactive PKCE + fixed-port loopback flow
 *    (mirroring its existing Google flow) and persists the refresh token via
 *    `safeStorage`, bridged through preload.cjs the same way Google is.
 *  - Capacitor: no existing deep-link infra in this repo before this file —
 *    uses `@capacitor/browser` to open the system browser for the auth URL
 *    and `@capacitor/app`'s `appUrlOpen` event to catch the custom-scheme
 *    redirect. PKCE verifier/challenge are generated client-side; the
 *    refresh token is stored directly in localStorage (a public PKCE client
 *    has no secret to protect, so this is the standard mobile pattern — see
 *    the plan doc for the explicit trade-off against native keychain
 *    storage).
 */

import type { BackupProvider, RemoteFingerprint, UploadOutcome } from "#system/offline/backup-provider";
import { isCapacitor, isElectron } from "#system/offline/backup-provider";

const DROPBOX_APP_KEY = "DROPBOX_APP_KEY_PLACEHOLDER"; // substituted at build time — same convention as GOOGLE_*_PLACEHOLDER
const DROPBOX_API_URL = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT_URL = "https://content.dropboxapi.com/2";
const DROPBOX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

const BACKUP_FILE_PATH = "/pkroffline-save-backup.json";

const DROPBOX_REFRESH_TOKEN_KEY = "pkrOfflineSync_dropbox_refreshToken";

// Must exactly match a redirect URI registered in the Dropbox App Console —
// see the plan doc's manual setup steps. Reuses the app's own reverse-DNS
// App ID as the scheme, same convention `xyz.scooom.pkr` already uses
// elsewhere (distinct from Google's flow, which is handled entirely inside
// the native SocialLogin SDK and never touches a custom scheme).
//
// Substituted at build time to the dev bundle ID's scheme
// (xyz.scooom.pkrdev) for dev builds — same placeholder-substitution
// convention as DROPBOX_APP_KEY/IOS_CLIENT_ID above. This MUST match
// whatever scheme android-manifest-url-scheme.js registered in the
// Manifest (it reads it from capacitor.config.json's appId, which is
// itself already dev/prod-branched) and whatever CFBundleURLTypes entry
// build-ios.yml registered — a mismatch here means the OS never routes the
// OAuth redirect back into the app at all.
const DROPBOX_CAPACITOR_REDIRECT_URI = "DROPBOX_REDIRECT_URI_PLACEHOLDER";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

export class DropboxProvider implements BackupProvider {
  readonly id = "dropbox";
  readonly displayName = "Dropbox";

  private cachedAccessToken: string | null = null;

  isAuthenticated(): boolean {
    return !!this.cachedAccessToken;
  }

  async tryRestoreSession(): Promise<boolean> {
    if (this.cachedAccessToken) {
      return true;
    }
    if (isElectron()) {
      return this.refreshFromElectron();
    }
    if (isCapacitor()) {
      return this.refreshFromCapacitor();
    }
    return false;
  }

  async signOut(): Promise<void> {
    this.cachedAccessToken = null;
    if (isElectron()) {
      await window.pkrOffline!.dropboxSignOut();
    } else if (isCapacitor()) {
      localStorage.removeItem(DROPBOX_REFRESH_TOKEN_KEY);
    }
  }

  async authenticate(): Promise<void> {
    if (isCapacitor()) {
      await this.authenticateCapacitor();
      return;
    }

    if (isElectron()) {
      const token = await window.pkrOffline!.dropboxSignIn();
      if (!token) {
        throw new Error("Dropbox sign-in did not return an access token.");
      }
      this.cachedAccessToken = token;
      return;
    }

    throw new Error("Dropbox sign-in is not supported in this build.");
  }

  private async refreshFromElectron(): Promise<boolean> {
    try {
      const hasStored = await window.pkrOffline!.hasStoredDropboxCredentials();
      if (!hasStored) {
        return false;
      }
      this.cachedAccessToken = await window.pkrOffline!.dropboxSignIn();
      return true;
    } catch (err) {
      console.warn("Silent Dropbox session restore failed:", err);
      return false;
    }
  }

  private async refreshFromCapacitor(): Promise<boolean> {
    const refreshToken = localStorage.getItem(DROPBOX_REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      return false;
    }
    try {
      this.cachedAccessToken = await this.exchangeRefreshToken(refreshToken);
      return true;
    } catch (err) {
      console.warn("Stored Dropbox credentials no longer work:", err);
      localStorage.removeItem(DROPBOX_REFRESH_TOKEN_KEY);
      return false;
    }
  }

  private async exchangeRefreshToken(refreshToken: string): Promise<string> {
    const res = await fetch(DROPBOX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: DROPBOX_APP_KEY,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Dropbox token refresh failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    if (!body.access_token) {
      throw new Error("Dropbox token refresh did not return an access token.");
    }
    return body.access_token;
  }

  /**
   * Opens the system browser for Dropbox's PKCE authorize screen and waits
   * for the custom-scheme redirect via `@capacitor/app`'s `appUrlOpen`
   * event. Neither `@capacitor/browser` nor `@capacitor/app` are imported at
   * the top of this file — both are native-only plugins with no meaningful
   * browser/Electron equivalent, dynamically imported here the same way
   * `google-drive-backup.ts` dynamically imports `@capgo/capacitor-social-login`.
   */
  private async authenticateCapacitor(): Promise<void> {
    const { Browser } = await import("@capacitor/browser");
    const { App } = await import("@capacitor/app");

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();

    const authUrl = new URL(DROPBOX_AUTHORIZE_URL);
    authUrl.searchParams.set("client_id", DROPBOX_APP_KEY);
    authUrl.searchParams.set("redirect_uri", DROPBOX_CAPACITOR_REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("token_access_type", "offline");
    authUrl.searchParams.set("state", state);

    const code = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let listenerHandle: { remove: () => Promise<void> } | null = null;

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        listenerHandle?.remove().catch(() => {});
        Browser.close().catch(() => {});
        fn();
      };

      const timeoutId = setTimeout(() => {
        finish(() => reject(new Error("Dropbox sign-in timed out.")));
      }, OAUTH_TIMEOUT_MS);

      App.addListener("appUrlOpen", ({ url }: { url: string }) => {
        if (!url.startsWith(DROPBOX_CAPACITOR_REDIRECT_URI)) {
          return;
        }
        const params = new URL(url).searchParams;
        const authCode = params.get("code");
        const returnedState = params.get("state");
        const error = params.get("error");

        if (authCode && returnedState === state) {
          finish(() => resolve(authCode));
        } else if (authCode) {
          finish(() => reject(new Error("Dropbox OAuth state mismatch — ignoring callback.")));
        } else {
          finish(() => reject(new Error(error ?? "No authorization code received.")));
        }
      }).then(handle => {
        listenerHandle = handle;
      });

      Browser.open({ url: authUrl.toString() });
    });

    const tokenRes = await fetch(DROPBOX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: DROPBOX_APP_KEY,
        code_verifier: verifier,
        redirect_uri: DROPBOX_CAPACITOR_REDIRECT_URI,
      }).toString(),
    });

    if (!tokenRes.ok) {
      throw new Error(`Dropbox token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }

    const body = await tokenRes.json();
    if (!body.access_token) {
      throw new Error("Dropbox sign-in did not return an access token.");
    }
    this.cachedAccessToken = body.access_token;
    if (body.refresh_token) {
      localStorage.setItem(DROPBOX_REFRESH_TOKEN_KEY, body.refresh_token);
    } else {
      console.warn("Dropbox did not return a refresh_token — the connection will not survive an app restart.");
    }
  }

  /** Attaches the current access token, and retries exactly once after a silent refresh on a 401. */
  private async authorizedFetch(input: string, init: RequestInit): Promise<Response> {
    if (!this.cachedAccessToken) {
      throw new Error("Not signed in — call authenticate() first.");
    }

    const attempt = () =>
      fetch(input, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.cachedAccessToken}` },
      });

    let res = await attempt();
    if (res.status === 401) {
      const refreshed = isElectron()
        ? await this.refreshFromElectron()
        : isCapacitor()
          ? await this.refreshFromCapacitor()
          : false;
      if (!refreshed) {
        throw new Error("Dropbox session expired and could not be silently refreshed.");
      }
      res = await attempt();
    }
    return res;
  }

  private async getMetadata(): Promise<RemoteFingerprint | null> {
    const res = await this.authorizedFetch(`${DROPBOX_API_URL}/files/get_metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: BACKUP_FILE_PATH }),
    });

    if (res.status === 409) {
      // path/not_found — no backup uploaded yet.
      return null;
    }
    if (!res.ok) {
      throw new Error(`Dropbox metadata lookup failed: ${res.status} ${await res.text()}`);
    }

    const body = await res.json();
    return { id: BACKUP_FILE_PATH, headRevisionId: body.rev ?? null, md5Checksum: null };
  }

  async getRemoteFingerprint(): Promise<RemoteFingerprint | null> {
    return this.getMetadata();
  }

  async download(): Promise<{ data: Record<string, string>; fingerprint: RemoteFingerprint; syncToken: string | null }> {
    const existing = await this.getMetadata();
    if (!existing) {
      throw new Error("No backup found in Dropbox to restore from.");
    }

    const res = await this.authorizedFetch(`${DROPBOX_CONTENT_URL}/files/download`, {
      method: "POST",
      headers: { "Dropbox-API-Arg": JSON.stringify({ path: BACKUP_FILE_PATH }) },
    });

    if (!res.ok) {
      throw new Error(`Dropbox download failed: ${res.status} ${await res.text()}`);
    }

    const parsed = await res.json();
    const data: Record<string, string> = parsed?.data ?? {};
    const syncToken = typeof parsed?.syncToken === "string" ? parsed.syncToken : null;

    return { data, fingerprint: existing, syncToken };
  }

  /**
   * Without `expectedFingerprint`: unconditional `mode: "overwrite"` (the
   * manual "Backup Save" path). With it: atomic conditional `mode: {".tag":
   * "update", "update": rev}` — if the remote has moved on since, Dropbox
   * responds 409 and this resolves to `{status: "conflict"}` instead of
   * throwing or clobbering it. The 409 conflict-detection predicate below
   * (`error_summary` containing "conflict") is the piece of this file most
   * likely to need adjusting once tested against a real account/response.
   */
  async upload(
    payload: Record<string, string>,
    opts?: { expectedFingerprint?: RemoteFingerprint },
  ): Promise<UploadOutcome> {
    const madeAt = new Date().toISOString();
    const syncToken = crypto.randomUUID();
    const fileContent = JSON.stringify({ backedUpAt: madeAt, syncToken, data: payload });

    const mode = opts?.expectedFingerprint?.headRevisionId
      ? ({ ".tag": "update", update: opts.expectedFingerprint.headRevisionId } as const)
      : ("overwrite" as const);

    const res = await this.authorizedFetch(`${DROPBOX_CONTENT_URL}/files/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ path: BACKUP_FILE_PATH, mode, autorename: false, mute: true }),
      },
      body: fileContent,
    });

    if (res.status === 409) {
      const body = await res.json().catch(() => null);
      const summary: string = body?.error_summary ?? "";
      if (summary.includes("conflict")) {
        return { status: "conflict" };
      }
      throw new Error(`Dropbox upload failed: 409 ${JSON.stringify(body)}`);
    }

    if (!res.ok) {
      throw new Error(`Dropbox upload failed: ${res.status} ${await res.text()}`);
    }

    const body = await res.json();
    return {
      status: "uploaded",
      fingerprint: { id: BACKUP_FILE_PATH, headRevisionId: body.rev ?? null, md5Checksum: null },
      syncToken,
    };
  }
}
