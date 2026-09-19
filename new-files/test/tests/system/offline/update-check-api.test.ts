import { checkForUpdates } from "#system/offline/update-check-api";
import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeRelease {
  tag_name: string;
  draft?: boolean;
  body?: string | null;
}

function mockReleases(releases: FakeRelease[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => releases,
      headers: { get: () => null },
    })),
  );
}

describe("System - Offline - update-check-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("checkForUpdates", () => {
    it("parses both 3-part and 4-part version tags", async () => {
      mockReleases([
        { tag_name: "v1.11.22-189", body: "" },
        { tag_name: "v1.12.0.5-204", body: "" },
      ]);

      const result = await checkForUpdates("1.0.0.0", 0);

      expect(result.map(r => r.version)).toEqual(["1.11.22", "1.12.0.5"]);
    });

    it("collapses same-version releases to the highest build number", async () => {
      mockReleases([
        { tag_name: "v1.12.0.5-204", body: "<!-- changelog:start -->build 204<!-- changelog:end -->" },
        { tag_name: "v1.12.0.5-210", body: "<!-- changelog:start -->build 210<!-- changelog:end -->" },
        { tag_name: "v1.12.0.5-205", body: "<!-- changelog:start -->build 205<!-- changelog:end -->" },
      ]);

      const result = await checkForUpdates("1.0.0.0", 0);

      expect(result).toHaveLength(1);
      expect(result[0].buildNumber).toBe(210);
      expect(result[0].changelog).toBe("build 210");
    });

    it("returns only versions strictly newer than installed, ascending", async () => {
      mockReleases([
        { tag_name: "v1.12.0.9-226", body: "" },
        { tag_name: "v1.12.0.4-198", body: "" },
        { tag_name: "v1.12.0.6-211", body: "" },
        { tag_name: "v1.12.0.5-204", body: "" },
      ]);

      const result = await checkForUpdates("1.12.0.4", 0);

      expect(result.map(r => r.version)).toEqual(["1.12.0.5", "1.12.0.6", "1.12.0.9"]);
    });

    it("ignores draft releases and malformed tags", async () => {
      mockReleases([
        { tag_name: "v1.12.0.5-204", draft: true, body: "" },
        { tag_name: "not-a-valid-tag", body: "" },
        { tag_name: "v1.12.0.6-211", body: "" },
      ]);

      const result = await checkForUpdates("1.0.0.0", 0);

      expect(result.map(r => r.version)).toEqual(["1.12.0.6"]);
    });

    it("uses the changelog text between the markers when present", async () => {
      mockReleases([
        {
          tag_name: "v1.12.0.5-204",
          body: "## PokeRogueOffline v1.12.0.5\n\n<!-- changelog:start -->\nFixed a bug.\n<!-- changelog:end -->\n\n- **PokeRogueOffline.ipa** — iOS",
        },
      ]);

      const result = await checkForUpdates("1.0.0.0", 0);

      expect(result[0].changelog).toBe("Fixed a bug.");
    });

    it("falls back to the body minus asset-filename lines when the markers are empty", async () => {
      mockReleases([
        {
          tag_name: "v1.12.0.5-204",
          body:
            "## PokeRogueOffline v1.12.0.5\n\n" +
            "<!-- changelog:start -->\n<!-- changelog:end -->\n\n" +
            "- **PokeRogueOffline.ipa** — iOS\n" +
            "- **PokeRogueOffline-x64.dmg** — macOS (Intel)",
        },
      ]);

      const result = await checkForUpdates("1.0.0.0", 0);

      expect(result[0].changelog).toBe("## PokeRogueOffline v1.12.0.5");
    });

    it("falls back to a literal message when the body is empty entirely", async () => {
      mockReleases([{ tag_name: "v1.12.0.5-204", body: "" }]);

      const result = await checkForUpdates("1.0.0.0", 0);

      expect(result[0].changelog).toBe("No changelog available for this version.");
    });

    it("returns an empty array when nothing is newer than the installed version", async () => {
      mockReleases([{ tag_name: "v1.12.0.5-204", body: "" }]);

      const result = await checkForUpdates("1.12.0.5", 204);

      expect(result).toEqual([]);
    });

    it("reports an update when only the build number changed for the installed version", async () => {
      mockReleases([{ tag_name: "v1.12.0.5-210", body: "" }]);

      const result = await checkForUpdates("1.12.0.5", 204);

      expect(result.map(r => r.version)).toEqual(["1.12.0.5"]);
      expect(result[0].buildNumber).toBe(210);
    });

    it("does not report an update for a same-or-older build of the installed version", async () => {
      mockReleases([{ tag_name: "v1.12.0.5-204", body: "" }]);

      const sameBuild = await checkForUpdates("1.12.0.5", 204);
      const olderBuild = await checkForUpdates("1.12.0.5", 210);

      expect(sameBuild).toEqual([]);
      expect(olderBuild).toEqual([]);
    });
  });
});
