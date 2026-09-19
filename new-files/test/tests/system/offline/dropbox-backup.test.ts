import { DropboxProvider } from "#system/offline/dropbox-backup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("System - Offline - dropbox-backup", () => {
  let provider: DropboxProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new DropboxProvider();
    // Poke the private cached access token directly — this provider has no
    // way to authenticate in a plain jsdom test environment (no
    // window.Capacitor / window.pkrOffline present), so tests exercising
    // upload()/download() need a token already "signed in".
    (provider as unknown as { cachedAccessToken: string | null }).cachedAccessToken = "test-access-token";

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("upload() conflict mapping", () => {
    it("uses mode: overwrite when no expectedFingerprint is given", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { rev: "rev-new" }));

      await provider.upload({ key: "value" });

      const [, init] = fetchMock.mock.calls[0];
      const arg = JSON.parse((init.headers as Record<string, string>)["Dropbox-API-Arg"]);
      expect(arg.mode).toBe("overwrite");
    });

    it("uses an atomic conditional mode: update with the expected rev and autorename: false", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { rev: "rev-new" }));

      await provider.upload(
        { key: "value" },
        { expectedFingerprint: { id: "/pkroffline-save-backup.json", headRevisionId: "rev-old", md5Checksum: null } },
      );

      const [, init] = fetchMock.mock.calls[0];
      const arg = JSON.parse((init.headers as Record<string, string>)["Dropbox-API-Arg"]);
      expect(arg.mode).toEqual({ ".tag": "update", update: "rev-old" });
      expect(arg.autorename).toBe(false);
    });

    it("resolves to a conflict result instead of throwing when Dropbox reports a path conflict", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, {
          error_summary: "path/conflict/file/...",
          error: { ".tag": "path", reason: { ".tag": "conflict" } },
        }),
      );

      const outcome = await provider.upload(
        { key: "value" },
        { expectedFingerprint: { id: "/pkroffline-save-backup.json", headRevisionId: "rev-old", md5Checksum: null } },
      );

      expect(outcome).toEqual({ status: "conflict" });
    });

    it("throws (does not silently swallow) on a 409 that isn't a conflict", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, { error_summary: "path/not_found/...", error: { ".tag": "path" } }),
      );

      await expect(provider.upload({ key: "value" })).rejects.toThrow();
    });

    it("throws on a genuine non-409 error response", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { error_summary: "internal_error" }));

      await expect(provider.upload({ key: "value" })).rejects.toThrow();
    });

    it("resolves to an uploaded outcome carrying the new rev on success", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { rev: "rev-new" }));

      const outcome = await provider.upload({ key: "value" });

      expect(outcome.status).toBe("uploaded");
      if (outcome.status === "uploaded") {
        expect(outcome.fingerprint.headRevisionId).toBe("rev-new");
        expect(outcome.fingerprint.md5Checksum).toBeNull();
      }
    });
  });

  describe("getRemoteFingerprint()", () => {
    it("returns null when Dropbox reports the file doesn't exist yet (409)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, { error_summary: "path/not_found/...", error: { ".tag": "path" } }),
      );

      await expect(provider.getRemoteFingerprint()).resolves.toBeNull();
    });

    it("maps the file's rev into headRevisionId, leaving md5Checksum null", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { rev: "rev-1" }));

      const fingerprint = await provider.getRemoteFingerprint();

      expect(fingerprint?.headRevisionId).toBe("rev-1");
      expect(fingerprint?.md5Checksum).toBeNull();
    });
  });
});
