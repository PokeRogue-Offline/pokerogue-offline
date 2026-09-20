/**
 * Fetches this fork's GitHub releases, collapses them down to one entry per
 * app version (keeping the highest build number when a version was released
 * more than once), and returns the changelog for every version strictly
 * newer than the one currently installed, oldest first.
 */

const OWNER = "PokeRogue-Offline";
const REPO = "pokerogue-offline";
const RELEASES_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`;

// Tags look like "v1.12.0.8-224" ({app version}-{CI build number}); a few
// historical tags only have a 3-part version ("v1.11.22-189").
const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:\.\d+)?)-(\d+)$/;

// Maintainers add real changelog text between these HTML comments by editing
// the published GitHub release. create-release.yaml ships them pre-populated
// but empty.
const CHANGELOG_START = "<!-- changelog:start -->";
const CHANGELOG_END = "<!-- changelog:end -->";

// Matches this project's own release asset filenames (e.g. "PokeRogueOffline.ipa",
// "PokeRogueOffline-x64.dmg") so the boilerplate download list can be stripped
// out of the fallback text.
const ASSET_FILENAME_PATTERN = /PokeRogueOffline[\w-]*\.\w+/i;

const FALLBACK_NO_CHANGELOG = "No changelog available for this version.";

export interface ReleaseInfo {
  version: string;
  buildNumber: number;
  tagName: string;
  changelog: string;
}

interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string | null;
}

// Duplicated from (not imported/exported from) version-migration/version-converter.ts's
// private extractVersion/compareVersions — that file is save-data-migration-critical,
// and this logic is small/self-contained enough that depending on it isn't worth the
// extra upstream-diff surface.
function extractVersion(versionString: string): number[] {
  const regex = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
  if (!regex.test(versionString)) {
    throw new Error(`Invalid version string (${versionString}) in update checker!`);
  }

  const versionArray = versionString.split(".").map(v => Number.parseInt(v, 10));
  if (versionArray.length === 3) {
    versionArray.push(0);
  }
  return versionArray;
}

function compareVersions(versionA: string, versionB: string): -1 | 0 | 1 {
  const a = extractVersion(versionA);
  const b = extractVersion(versionB);

  for (let i = 0; i < 4; i++) {
    if (a[i] > b[i]) {
      return 1;
    }
    if (a[i] < b[i]) {
      return -1;
    }
  }

  return 0;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

async function fetchAllReleases(): Promise<GhRelease[]> {
  const releases: GhRelease[] = [];
  let url: string | null = RELEASES_URL;

  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      break;
    }
    const page = (await response.json()) as GhRelease[];
    releases.push(...page);
    url = parseNextLink(response.headers.get("Link"));
  }

  // A release is published prerelease:true and manually flipped off once
  // ready to go live - prerelease releases are treated the same as drafts
  // and hidden from the updater until then.
  return releases.filter(r => !r.draft && !r.prerelease);
}

/**
 * Returns the maintainer-authored changelog for a release, or a graceful
 * fallback when none has been added yet: the release's own body with the
 * marker lines and its own download-asset lines stripped out.
 */
function extractChangelog(body: string | null | undefined): string {
  const text = (body ?? "").replace(/\r\n/g, "\n");

  const startIdx = text.indexOf(CHANGELOG_START);
  const endIdx = text.indexOf(CHANGELOG_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const between = text.slice(startIdx + CHANGELOG_START.length, endIdx).trim();
    if (between.length > 0) {
      return between;
    }
  }

  const filtered = text
    .split("\n")
    .filter(line => !line.includes(CHANGELOG_START) && !line.includes(CHANGELOG_END))
    .filter(line => !ASSET_FILENAME_PATTERN.test(line))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join("\n");

  return filtered.length > 0 ? filtered : FALLBACK_NO_CHANGELOG;
}

/**
 * Returns one entry per app version strictly newer than `installedVersion`,
 * ascending, up to and including the latest release. When a version was
 * released more than once (e.g. a same-version rebuild/hotfix), only the
 * highest build number's changelog is kept for that version's page.
 *
 * Most of this fork's own releases don't bump the upstream app version at
 * all (it's upstream pagefaultgames/pokerogue's package.json version, not
 * something this fork controls) - only the CI build number embedded in the
 * tag changes. So a release matching `installedVersion` is still reported
 * as an update when its build number is strictly higher than
 * `installedBuildNumber`.
 */
export async function checkForUpdates(
  installedVersion: string,
  installedBuildNumber: number,
): Promise<ReleaseInfo[]> {
  const releases = await fetchAllReleases();

  const byVersion = new Map<string, ReleaseInfo>();
  for (const release of releases) {
    const match = release.tag_name?.match(TAG_PATTERN);
    if (!match) {
      continue;
    }

    const [, versionStr, buildStr] = match;
    const buildNumber = Number.parseInt(buildStr, 10);
    const existing = byVersion.get(versionStr);
    if (!existing || buildNumber > existing.buildNumber) {
      byVersion.set(versionStr, {
        version: versionStr,
        buildNumber,
        tagName: release.tag_name,
        changelog: extractChangelog(release.body),
      });
    }
  }

  return Array.from(byVersion.values())
    .filter(r => {
      const cmp = compareVersions(r.version, installedVersion);
      return cmp === 1 || (cmp === 0 && r.buildNumber > installedBuildNumber);
    })
    .sort((a, b) => compareVersions(a.version, b.version));
}
