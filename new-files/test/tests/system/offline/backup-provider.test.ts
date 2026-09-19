import { isSafeToAutoUpload } from "#system/offline/backup-provider";
import { describe, expect, it } from "vitest";

describe("System - Offline - backup-provider", () => {
  describe("isSafeToAutoUpload", () => {
    it("is safe when no remote backup exists yet (nothing to overwrite)", () => {
      expect(isSafeToAutoUpload(null, null)).toBe(true);
      expect(
        isSafeToAutoUpload({ headRevisionId: "rev-1", md5Checksum: null, syncToken: null }, null),
      ).toBe(true);
    });

    it("is unsafe when a remote backup exists but this device has never synced before", () => {
      // This is the device-B scenario: an older device that never loaded
      // device A's upload must not clobber it.
      expect(
        isSafeToAutoUpload(null, { id: "file-1", headRevisionId: "rev-1", md5Checksum: "md5-1" }),
      ).toBe(false);
    });

    it("is safe when the remembered headRevisionId still matches the remote's", () => {
      expect(
        isSafeToAutoUpload(
          { headRevisionId: "rev-1", md5Checksum: null, syncToken: null },
          { id: "file-1", headRevisionId: "rev-1", md5Checksum: "md5-1" },
        ),
      ).toBe(true);
    });

    it("is unsafe when the remembered headRevisionId no longer matches the remote's", () => {
      // Another device uploaded since this device last synced.
      expect(
        isSafeToAutoUpload(
          { headRevisionId: "rev-1", md5Checksum: null, syncToken: null },
          { id: "file-1", headRevisionId: "rev-2", md5Checksum: "md5-1" },
        ),
      ).toBe(false);
    });

    it("falls back to md5Checksum when headRevisionId isn't available on either side", () => {
      expect(
        isSafeToAutoUpload(
          { headRevisionId: null, md5Checksum: "md5-1", syncToken: null },
          { id: "file-1", headRevisionId: null, md5Checksum: "md5-1" },
        ),
      ).toBe(true);
      expect(
        isSafeToAutoUpload(
          { headRevisionId: null, md5Checksum: "md5-1", syncToken: null },
          { id: "file-1", headRevisionId: null, md5Checksum: "md5-2" },
        ),
      ).toBe(false);
    });

    it("is unsafe (conservative default) when neither fingerprint field is comparable", () => {
      expect(
        isSafeToAutoUpload(
          { headRevisionId: null, md5Checksum: null, syncToken: "token-1" },
          { id: "file-1", headRevisionId: null, md5Checksum: null },
        ),
      ).toBe(false);
    });

    it("prefers headRevisionId over md5Checksum when both are present and only one still matches", () => {
      // headRevisionId disagrees (unsafe) even though md5Checksum still happens to match.
      expect(
        isSafeToAutoUpload(
          { headRevisionId: "rev-1", md5Checksum: "md5-1", syncToken: null },
          { id: "file-1", headRevisionId: "rev-2", md5Checksum: "md5-1" },
        ),
      ).toBe(false);
    });
  });
});
