import * as backupManager from "#system/offline/backup-manager";
import type { BackupProvider, RemoteFingerprint, UploadOutcome } from "#system/offline/backup-provider";
import { beforeEach, describe, expect, it } from "vitest";

class FakeProvider implements BackupProvider {
  readonly id: string;
  readonly displayName: string;

  authenticated = true;
  remoteFingerprint: RemoteFingerprint | null = null;
  uploadOutcome: UploadOutcome = {
    status: "uploaded",
    fingerprint: { id: "fake-file", headRevisionId: "rev-1", md5Checksum: null },
    syncToken: "sync-token-1",
  };
  downloadResult: { data: Record<string, string>; fingerprint: RemoteFingerprint; syncToken: string | null } = {
    data: {},
    fingerprint: { id: "fake-file", headRevisionId: "rev-1", md5Checksum: null },
    syncToken: "sync-token-1",
  };

  // `expectedFingerprint` is `| undefined` rather than optional (`?:`) here
  // deliberately — this records what was actually passed, including an
  // explicit `undefined`, and `exactOptionalPropertyTypes` forbids assigning
  // `undefined` to a genuinely optional property.
  uploadCalls: Array<{ payload: Record<string, string>; expectedFingerprint: RemoteFingerprint | undefined }> = [];
  downloadCalls = 0;
  getRemoteFingerprintCalls = 0;

  constructor(id: string, displayName: string) {
    this.id = id;
    this.displayName = displayName;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }
  async authenticate(): Promise<void> {
    this.authenticated = true;
  }
  async signOut(): Promise<void> {
    this.authenticated = false;
  }
  async tryRestoreSession(): Promise<boolean> {
    return this.authenticated;
  }
  async getRemoteFingerprint(): Promise<RemoteFingerprint | null> {
    this.getRemoteFingerprintCalls++;
    return this.remoteFingerprint;
  }
  async download() {
    this.downloadCalls++;
    return this.downloadResult;
  }
  async upload(
    payload: Record<string, string>,
    opts?: { expectedFingerprint?: RemoteFingerprint },
  ): Promise<UploadOutcome> {
    this.uploadCalls.push({ payload, expectedFingerprint: opts?.expectedFingerprint });
    return this.uploadOutcome;
  }
}

describe("System - Offline - backup-manager", () => {
  let providerA: FakeProvider;
  let providerB: FakeProvider;

  beforeEach(() => {
    localStorage.clear();
    providerA = new FakeProvider("provider-a", "Provider A");
    providerB = new FakeProvider("provider-b", "Provider B");
    backupManager.__setProvidersForTest([providerA, providerB]);
  });

  describe("provider routing", () => {
    it("defaults to the first registered provider", () => {
      expect(backupManager.getActiveProvider().id).toBe("provider-a");
    });

    it("switchProvider() changes the active provider without making any network call", () => {
      backupManager.switchProvider("provider-b");

      expect(backupManager.getActiveProvider().id).toBe("provider-b");
      expect(providerA.downloadCalls).toBe(0);
      expect(providerB.downloadCalls).toBe(0);
      expect(providerA.getRemoteFingerprintCalls).toBe(0);
      expect(providerB.getRemoteFingerprintCalls).toBe(0);
      expect(providerA.uploadCalls.length).toBe(0);
      expect(providerB.uploadCalls.length).toBe(0);
    });

    it("backupSave() uploads through the active provider only", async () => {
      await backupManager.backupSave();
      expect(providerA.uploadCalls.length).toBe(1);
      expect(providerB.uploadCalls.length).toBe(0);

      backupManager.switchProvider("provider-b");
      await backupManager.backupSave();
      expect(providerA.uploadCalls.length).toBe(1);
      expect(providerB.uploadCalls.length).toBe(1);
    });

    it("backupSave() uploads unconditionally (no expectedFingerprint)", async () => {
      await backupManager.backupSave();
      expect(providerA.uploadCalls[0].expectedFingerprint).toBeUndefined();
    });

    it("restoreFromBackup() downloads through the active provider only", async () => {
      backupManager.switchProvider("provider-b");
      await backupManager.restoreFromBackup();
      expect(providerA.downloadCalls).toBe(0);
      expect(providerB.downloadCalls).toBe(1);
    });

    it("autoSyncCheckpoint() operates on the active provider only", async () => {
      providerA.remoteFingerprint = null; // no remote yet — safe to upload
      await backupManager.autoSyncCheckpoint();
      expect(providerA.uploadCalls.length).toBe(1);
      expect(providerB.uploadCalls.length).toBe(0);
    });
  });

  describe("autoSyncCheckpoint gating", () => {
    it("does nothing if the active provider isn't authenticated", async () => {
      providerA.authenticated = false;
      await backupManager.autoSyncCheckpoint();
      expect(providerA.getRemoteFingerprintCalls).toBe(0);
      expect(providerA.uploadCalls.length).toBe(0);
    });

    it("does nothing if the debounce window hasn't elapsed since the last attempt", async () => {
      localStorage.setItem("pkrOfflineSync_lastAttempt", String(Date.now()));
      await backupManager.autoSyncCheckpoint();
      expect(providerA.getRemoteFingerprintCalls).toBe(0);
      expect(providerA.uploadCalls.length).toBe(0);
    });

    it("skips the upload (but records the attempt) when the safety check fails", async () => {
      // Remote exists but nothing is remembered locally yet — unsafe.
      providerA.remoteFingerprint = { id: "fake-file", headRevisionId: "rev-remote", md5Checksum: null };

      await backupManager.autoSyncCheckpoint();

      expect(providerA.getRemoteFingerprintCalls).toBe(1);
      expect(providerA.uploadCalls.length).toBe(0);
      expect(localStorage.getItem("pkrOfflineSync_lastAttempt")).not.toBeNull();
    });

    it("uploads with the remote fingerprint attached when the safety check passes", async () => {
      providerA.remoteFingerprint = null; // no remote yet — safe

      await backupManager.autoSyncCheckpoint();

      expect(providerA.uploadCalls.length).toBe(1);
      expect(providerA.uploadCalls[0].expectedFingerprint).toBeUndefined();
    });

    it("passes the remote fingerprint as expectedFingerprint when one exists and matches", async () => {
      const remote: RemoteFingerprint = { id: "fake-file", headRevisionId: "rev-1", md5Checksum: null };
      providerA.remoteFingerprint = remote;
      // Pre-seed the remembered fingerprint to match the remote, so the
      // safety check passes. providerA's id is "provider-a", not the
      // default "google-drive", so its fingerprint key is suffixed.
      localStorage.setItem(
        "pkrOfflineSync_provider-a_fingerprint",
        JSON.stringify({ headRevisionId: "rev-1", md5Checksum: null, syncToken: null }),
      );

      await backupManager.autoSyncCheckpoint();

      expect(providerA.uploadCalls.length).toBe(1);
      expect(providerA.uploadCalls[0].expectedFingerprint).toEqual(remote);
    });

    it("treats a conflict outcome the same as a failed safety check — no fingerprint update, still records the attempt", async () => {
      providerA.remoteFingerprint = null; // safety check passes
      providerA.uploadOutcome = { status: "conflict" };

      await backupManager.autoSyncCheckpoint();

      expect(providerA.uploadCalls.length).toBe(1);
      // Not `.toBeNull()` — a missing key reads back as `undefined` in this
      // project's test environment, not the Web Storage spec's `null`.
      expect(localStorage.getItem("pkrOfflineSync_provider-a_fingerprint")).toBeFalsy();
      expect(localStorage.getItem("pkrOfflineSync_lastAttempt")).toBeTruthy();
    });

    it("never throws, even if the provider rejects", async () => {
      providerA.remoteFingerprint = null;
      providerA.getRemoteFingerprint = async () => {
        throw new Error("network error");
      };

      await expect(backupManager.autoSyncCheckpoint()).resolves.toBeUndefined();
    });
  });

  describe("disconnectActiveProvider()", () => {
    it("signs out the active provider and clears its fingerprint", async () => {
      await backupManager.backupSave(); // establishes providerA's fingerprint
      expect(localStorage.getItem("pkrOfflineSync_provider-a_fingerprint")).toBeTruthy();

      await backupManager.disconnectActiveProvider();

      expect(providerA.authenticated).toBe(false);
      expect(localStorage.getItem("pkrOfflineSync_provider-a_fingerprint")).toBeFalsy();
    });

    it("leaves other providers untouched", async () => {
      backupManager.switchProvider("provider-b");
      await backupManager.backupSave(); // establishes providerB's fingerprint

      await backupManager.disconnectActiveProvider();

      expect(providerA.authenticated).toBe(true);
      expect(localStorage.getItem("pkrOfflineSync_provider-a_fingerprint")).toBeFalsy();
    });
  });

  describe("authenticateActiveProvider()", () => {
    it("authenticates the active provider", async () => {
      providerA.authenticated = false;

      await backupManager.authenticateActiveProvider();

      expect(providerA.authenticated).toBe(true);
    });

    it("signs out and clears the fingerprint of every other registered provider on success", async () => {
      backupManager.switchProvider("provider-b");
      await backupManager.backupSave(); // establishes providerA's fingerprint from an earlier session
      localStorage.setItem("pkrOfflineSync_provider-a_fingerprint", JSON.stringify({ headRevisionId: "stale" }));
      providerA.authenticated = true;

      await backupManager.authenticateActiveProvider();

      expect(providerA.authenticated).toBe(false);
      expect(localStorage.getItem("pkrOfflineSync_provider-a_fingerprint")).toBeFalsy();
    });

    it("does not touch other providers if authenticate() itself throws", async () => {
      backupManager.switchProvider("provider-b");
      providerB.authenticate = async () => {
        throw new Error("auth failed");
      };

      await expect(backupManager.authenticateActiveProvider()).rejects.toThrow("auth failed");

      expect(providerA.authenticated).toBe(true);
    });
  });

  describe("restore prompt offered flag", () => {
    it("is false until marked", () => {
      expect(backupManager.hasOfferedRestorePrompt()).toBe(false);
      backupManager.markRestorePromptOffered();
      expect(backupManager.hasOfferedRestorePrompt()).toBe(true);
    });

    it("survives being read again (persisted, not in-memory)", () => {
      backupManager.markRestorePromptOffered();
      expect(backupManager.hasOfferedRestorePrompt()).toBe(true);
      expect(backupManager.hasOfferedRestorePrompt()).toBe(true);
    });

    it("is cleared by a successful authenticateActiveProvider() call", async () => {
      backupManager.markRestorePromptOffered();
      providerA.authenticated = false;

      await backupManager.authenticateActiveProvider();

      expect(backupManager.hasOfferedRestorePrompt()).toBe(false);
    });

    it("is left untouched if authenticateActiveProvider() throws", async () => {
      backupManager.switchProvider("provider-b");
      backupManager.markRestorePromptOffered();
      providerB.authenticate = async () => {
        throw new Error("auth failed");
      };

      await expect(backupManager.authenticateActiveProvider()).rejects.toThrow("auth failed");

      expect(backupManager.hasOfferedRestorePrompt()).toBe(true);
    });

    it("is cleared by disconnectActiveProvider()", async () => {
      backupManager.markRestorePromptOffered();

      await backupManager.disconnectActiveProvider();

      expect(backupManager.hasOfferedRestorePrompt()).toBe(false);
    });
  });

  describe("per-provider fingerprint storage", () => {
    it("keeps Google Drive's fingerprint key unsuffixed for zero-migration compatibility", async () => {
      backupManager.__setProvidersForTest([
        Object.assign(new FakeProvider("google-drive", "Google Drive"), { remoteFingerprint: null }),
        providerB,
      ]);

      await backupManager.backupSave();

      expect(localStorage.getItem("pkrOfflineSync_fingerprint")).toBeTruthy();
      // Not `.toBeNull()` — a missing key reads back as `undefined` in this
      // project's test environment, not the Web Storage spec's `null`.
      expect(localStorage.getItem("pkrOfflineSync_google-drive_fingerprint")).toBeFalsy();
    });

    it("gives a non-default provider its own suffixed fingerprint key", async () => {
      backupManager.switchProvider("provider-b");
      await backupManager.backupSave();

      expect(localStorage.getItem("pkrOfflineSync_provider-b_fingerprint")).not.toBeNull();
    });
  });
});
