/**
 * Capacitor (Android/iOS) auto-updater. Self-hosted off this fork's own
 * GitHub Releases, same as configs/desktop/electron/updater.cjs - no
 * third-party live-update service involved.
 *
 * Two update paths, chosen per-release by comparing this build's own native
 * fingerprint (baked in at build time, see scripts/compute-native-
 * fingerprint.js) against the release's published one:
 *   - "ota": fingerprints match - the release only changed web content, so
 *     the installed native shell (Capacitor plugin set, MainActivity.java/
 *     AppDelegate.swift, manifest/Info.plist permissions, URL schemes) still
 *     supports it. The web content itself is split into three
 *     independently-updatable channels - code, assets, locales - so a
 *     release that only changed code doesn't force re-downloading the
 *     (much larger) assets/locales bundles; see ota-parts.ts for how each
 *     channel is downloaded/staged/activated and resolveOtaChannels()
 *     below for how it's decided which ones actually need it. Activated in
 *     place via the stock Capacitor setServerBasePath plugin method (both
 *     platforms - see IOS_OTA_CONFIRMED below). No checksum verification
 *     (trusts the HTTPS transport instead) - see downloadToFile()'s doc
 *     comment for why.
 *   - "native-android" / "native-ios-notify-only": fingerprints differ - a
 *     real reinstall is needed, which neither platform can do fully in-app.
 *     Android downloads the real APK and hands it to the system installer
 *     (OtaBridgePlugin.installApk - this *hands off*, it does not install
 *     anything itself). iOS has no equivalent - sideloaded installs can only
 *     be replaced by another sideload, so SideStore/AltStore users get
 *     native updates through the already-existing AltStore source
 *     (scripts/update-altstore-source.js) instead, as a separate channel.
 *
 * ── Dev release channel ─────────────────────────────────────────────────
 * Dev-flagged builds (isScoomDev) match a second, `dev-`-prefixed tag
 * pattern and don't filter out `prerelease` (dev releases are always
 * prerelease, never promoted) - see create-release.yaml's "Compute release
 * tag/title" step. Real builds structurally can't match dev tags (their own
 * tag pattern is anchored to "v...", not "dev-v..."), so this is enforced on
 * both sides, not just here. The manifest's `channel` field is checked as a
 * second, independent safety gate on top of the tag match.
 *
 * ── Activation and rollback ──────────────────────────────────────────────
 * Each channel is staged into a scratch directory and only swapped into
 * the one served directory (`ota/active/`) after the stage is fully
 * written - never written into the currently-active content in place -
 * and a per-channel backup of the last CONFIRMED version is kept until
 * the new version proves it boots.
 *
 * The swap itself is several directory renames, so it is NOT atomic: the
 * app can be killed with a channel half moved. Earlier versions of this
 * comment claimed that state could not occur; it could, and boot then saw
 * a confirmed pointer over half-swapped files and never recovered. It is
 * now handled explicitly: a write-ahead marker is written before the
 * first rename and removed after the new pointer is written, and the boot
 * hook finishes or undoes any swap whose marker is still there before
 * anything is served. A version that is fully swapped in but then fails
 * to reach the title screen on repeated launches is rolled back to the
 * backup (see reapplyActiveOtaBundleIfAny / confirmOtaBootSuccess, and
 * ota-core.ts for the mechanics, which the desktop build shares).
 *
 * OTA content is also tied to the native build it was installed under:
 * after the app itself is reinstalled or updated to a build with a
 * different native fingerprint, leftover OTA content is discarded on the
 * next launch instead of being served over the newer bundled content.
 */

import {
  type ChannelSize,
  estimateRequiredBytes,
  findApplicableRelease as coreFindApplicableRelease,
  type MatchedRelease,
  type ReleaseAsset,
  type ReleaseLike,
  TAG_PATTERN,
} from "#system/offline/ota-core";
import {
  applyChannelUpdate,
  bootstrapActive,
  CHANNELS,
  type ChannelName,
  confirmPartsBootSuccess,
  getActiveDirUri,
  getFreeBytes,
  isOtaBootstrapped,
  markPartsLoadReached,
  readChannelPointer,
  reapplyActivePartsIfAny,
  type UnzipExpectation,
} from "#system/offline/ota-parts";
import { isScoomDev } from "#system/offline/scooom-dev";

const OWNER = "PokeRogue-Offline";
const REPO = "pokerogue-offline";
const RELEASES_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`;
const LATEST_RELEASE_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

// Substituted at build time by .github/actions/inject-native-fingerprint,
// the same placeholder-injection mechanism used for OFFLINE_BUILD_NUMBER
// elsewhere in this pipeline. Left unsubstituted (dev/local runs outside
// CI) means getInstalledNativeFingerprint() returns null and this whole
// module's checks are skipped - matching the same "no placeholder, no
// update checks" convention used throughout this fork.
const INSTALLED_NATIVE_FINGERPRINT = "NATIVE_FINGERPRINT_PLACEHOLDER";

// setServerBasePath is a STOCK Capacitor plugin method (CAPWebViewPlugin on
// iOS, com.getcapacitor.plugin.WebView on Android - both auto-registered by
// Capacitor core, no custom native plugin needed), confirmed directly
// against ionic-team/capacitor's own source for both platforms. The WebView
// base-path swap this whole OTA path depends on is therefore equally
// supported on iOS and Android - see webViewPlugin()/setBasePath() below.
const IOS_OTA_CONFIRMED = true;

// Deliberately never compares against the literal text
// "NATIVE_FINGERPRINT_PLACEHOLDER" - inject-native-fingerprint's sed command
// (s/NATIVE_FINGERPRINT_PLACEHOLDER/<hash>/g) is a GLOBAL replace over the
// whole file, so any occurrence of that literal string here - including one
// written specifically to compare against it - gets rewritten too. The
// previous two versions of this function both did exactly that
// (`... === "NATIVE_FINGERPRINT_PLACEHOLDER"`), so after sed ran, the
// comparison silently became "real hash === real hash" - always true,
// always returning null. Confirmed against an actual shipped build (its
// compiled getInstalledNativeFingerprint() was a hardcoded `return null`)
// and reproduced locally by running this exact sed substitution. This has
// been broken on both platforms since the OTA feature first shipped (#21).
// A real SHA-256 digest is always exactly 64 lowercase hex characters, which
// is a strictly more correct check anyway and contains no text sed can
// collide with.
function getInstalledNativeFingerprint(): string | null {
  return /^[0-9a-f]{64}$/.test(INSTALLED_NATIVE_FINGERPRINT) ? INSTALLED_NATIVE_FINGERPRINT : null;
}

function cap(): any {
  return typeof window !== "undefined" ? (window as any).Capacitor : undefined;
}

function platform(): "android" | "ios" | null {
  const p = cap()?.getPlatform?.();
  return p === "android" || p === "ios" ? p : null;
}

function filesystem(): any {
  return cap()?.Plugins?.Filesystem;
}

function otaBridge(): any {
  return cap()?.Plugins?.OtaBridge;
}

/**
 * Stock Capacitor plugin (bundled in @capacitor/core - no install/version
 * pin needed), auto-registered on both platforms. Used for every GitHub
 * release-asset fetch in this module instead of the WebView's own fetch():
 * browser_download_url always 302-redirects to a signed release-assets.
 * githubusercontent.com URL, and that redirect target sends no
 * Access-Control-Allow-Origin header permitting the app's capacitor://
 * origin - confirmed directly from an actual device's console
 * ("Cross-origin redirection ... denied by Cross-Origin Resource Sharing
 * policy"). CapacitorHttp.request() runs the request natively (NSURLSession/
 * OkHttp), which has no concept of browser CORS, so it just follows the
 * redirect and returns the content.
 */
function capacitorHttp(): any {
  return cap()?.Plugins?.CapacitorHttp;
}

/**
 * @capacitor/file-transfer - NOT bundled in core, pinned like the other
 * mobile-only packages (see configs/capacitor-versions.env). Used only for
 * the large binary downloads (OTA zip, APK), which CapacitorHttp itself
 * can't handle well: it has to base64 the whole response across the JS
 * bridge, and these files run into the hundreds of MB. FileTransfer streams
 * straight to a file natively, with progress events, and sidesteps the same
 * CORS wall CapacitorHttp sidesteps for the small fetches above.
 */
function fileTransfer(): any {
  return cap()?.Plugins?.FileTransfer;
}

/** Stock Capacitor plugin, auto-registered on both platforms - see IOS_OTA_CONFIRMED above. */
function webViewPlugin(): any {
  return cap()?.Plugins?.WebView;
}

/**
 * Re-points the WebView at `path` via the stock setServerBasePath plugin method - the
 * one real mechanism both OTA paths (stage+activate and boot-time reapply) share.
 *
 * `path` is always a file:// URI (from Capacitor's own Filesystem.getUri()), but both
 * platforms' actual native setServerBasePath implementation expects a plain
 * filesystem path, not a URI - confirmed directly against Capacitor's real source for
 * both: iOS's CapacitorBridge.setServerBasePath(_:) does
 * `URL(fileURLWithPath: path, isDirectory: true)` (which does not parse a `file:`
 * scheme - a string starting with "file://" doesn't start with "/", so it resolves
 * relative to the process's cwd into a nonexistent path, and the function's own
 * `FileManager.fileExists` guard then silently no-ops); Android's
 * AndroidProtocolHandler.openFile(String) does `new File(filePath)` directly on the
 * raw string, same problem. Passing the untouched URI meant the asset path never
 * actually switched on either platform, even though the plugin call itself "resolved"
 * successfully - confirmed on-device (the app kept serving the old bundled content and
 * re-offering the same update indefinitely). Stripping the scheme here fixes every
 * caller at once.
 */
async function setBasePath(path: string): Promise<void> {
  const plugin = webViewPlugin();
  const nativePath = path.replace(/^file:\/\//, "");
  console.log(`[mobile-updater] setBasePath(${path}) - WebView plugin ${plugin ? "found" : "NOT FOUND"}`);
  await plugin?.setServerBasePath({ path: nativePath });
  console.log(`[mobile-updater] setBasePath(${path}) done`);
}

export type MobileUpdateKind = "ota" | "native-android" | "native-ios-notify-only";

/** One channel (code/assets/locales) that needs to be downloaded+applied - see ota-parts.ts for why these are independent. */
export interface MobileOtaChannelUpdate {
  asset: GhAsset;
  /** The channel's new content-hash version, from the manifest - passed straight through to bootstrapActive()/applyChannelUpdate(). */
  version: string;
  /** Size of the zip in bytes (manifest, else the GitHub asset's own size); 0 when neither is known. */
  bytes: number;
  /** Size of the channel once unzipped, when the manifest says. */
  unpackedBytes?: number | undefined;
  /** What the native unzip must find: the zip's exact size and its number of file entries. Absent fields are not checked. */
  expect: UnzipExpectation;
}

export interface MobileUpdateCheckResult {
  version: string;
  buildNumber: number;
  kind: MobileUpdateKind;
  /** Only set for kind "ota" - one entry per channel that actually needs updating (all three, on this install's first-ever OTA). */
  otaChannels?: Partial<Record<ChannelName, MobileOtaChannelUpdate>>;
  /** Only set for kind "native-android" - needed by downloadMobileUpdate(). */
  apkAsset?: GhAsset;
}

type GhAsset = ReleaseAsset;

interface GhRelease extends ReleaseLike {
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
}

interface OtaManifestChannel {
  version: string;
  sha256: string;
  assetName: string;
  /** Size of the channel zip. Optional: manifests published before the truncation guard don't have it. */
  bytes?: number;
  /** Number of file entries in the channel zip. Optional, as above. */
  entries?: number;
  /** Total size of the channel's files once unzipped. Optional, as above. */
  unpackedBytes?: number;
}

/**
 * v2 manifest shape - one entry per independently-updatable channel (see
 * ota-parts.ts), replacing the old flat `{otaBundleSha256}` single-bundle
 * shape. `schemaVersion` is checked explicitly (see checkForMobileUpdate)
 * and anything other than 2 is treated as unusable rather than read
 * partially - an old (pre-split) client reading THIS shape would simply
 * not find `otaBundleSha256` (never checksum-verified client-side anyway,
 * see downloadToFile()'s comment), which degrades safely without needing
 * a version check on that side.
 */
interface OtaManifest {
  schemaVersion: number;
  version: string;
  buildNumber: number;
  nativeFingerprint: string;
  channel: "stable" | "dev";
  code: OtaManifestChannel;
  assets: OtaManifestChannel;
  locales: OtaManifestChannel;
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
  // Dev releases are always prerelease (never promoted) - dev-flagged builds
  // must NOT filter them out. Real builds' tag pattern can't match a
  // dev-prefixed tag anyway, but keep the prerelease filter for them too,
  // matching update-check-api.ts's/updater.cjs's existing convention
  // ("staged, not yet promoted" releases are hidden from real builds).
  return releases.filter(r => !r.draft && (isScoomDev || !r.prerelease));
}

/**
 * The releases worth considering for this build. Stable builds ask for
 * GitHub's single "latest" release (the newest published, non-prerelease
 * one - the only release a stable build would pick anyway) instead of
 * paging the entire release history, and fall back to the full list if
 * that request fails or returns something unexpected. Dev builds always
 * page: dev releases are prereleases, which "latest" never returns.
 */
async function fetchCandidateReleases(): Promise<GhRelease[]> {
  if (!isScoomDev) {
    try {
      const response = await fetch(LATEST_RELEASE_URL);
      if (response.ok) {
        const latest = (await response.json()) as GhRelease | null;
        if (latest && typeof latest.tag_name === "string" && TAG_PATTERN.test(latest.tag_name) && !latest.draft && !latest.prerelease) {
          return [latest];
        }
      }
    } catch {
      // fall through to the full list
    }
  }
  return fetchAllReleases();
}

/** Newest release ahead of the installed build for this build's channel (stable or dev), or null. */
export function findApplicableRelease(releases: ReleaseLike[], installedVersion: string, installedBuildNumber: number): MatchedRelease | null {
  const result = coreFindApplicableRelease(releases, installedVersion, installedBuildNumber, isScoomDev);
  console.log(
    `[mobile-updater] findApplicableRelease: ${releases.length} release(s), isScoomDev=${isScoomDev}, installed=${installedVersion}+${installedBuildNumber} -> picked:`,
    result ? `${result.version}+${result.buildNumber}` : null,
  );
  return result;
}

function findAsset(assets: GhAsset[], name: string): GhAsset | undefined {
  return assets.find(a => a.name === name);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Decides which of the three channels actually need downloading - all
 * three if this install has never had an OTA bootstrapped yet (nothing
 * to compare against), otherwise only the ones whose manifest version
 * differs from what's currently installed (see ota-parts.ts's two
 * lifecycles). Returns null if any NEEDED channel's asset is missing from
 * the release - same all-or-nothing strictness the single-bundle version
 * of this check used to have.
 *
 * Asset names are reconstructed from the fixed release-asset naming
 * convention (create-release.yaml's renames), not read from the
 * manifest's own `assetName` field - that field holds the pre-rename name
 * CI used internally (e.g. "ota-code.zip"), not the actual published
 * release asset name.
 */
async function resolveOtaChannels(
  plat: "android" | "ios",
  releaseAssets: GhAsset[],
  manifest: OtaManifest,
): Promise<Partial<Record<ChannelName, MobileOtaChannelUpdate>> | null> {
  const bootstrapped = await isOtaBootstrapped();
  console.log(`[mobile-updater] resolveOtaChannels: bootstrapped=${bootstrapped}`);

  const platformName = plat === "android" ? "Android" : "iOS";
  const result: Partial<Record<ChannelName, MobileOtaChannelUpdate>> = {};

  for (const channel of CHANNELS) {
    const manifestChannel = manifest[channel];
    let needed = !bootstrapped; // first-ever OTA needs all three, regardless of version comparison
    if (!needed) {
      const installedPointer = await readChannelPointer(channel);
      needed = installedPointer?.version !== manifestChannel.version;
    }
    if (!needed) {
      continue;
    }

    const assetName = `PokeRogueOffline-${platformName}-ota-${channel}.zip`;
    const asset = findAsset(releaseAssets, assetName);
    console.log(`[mobile-updater] resolveOtaChannels: ${channel} needed, looking for "${assetName}" -> ${asset ? "found" : "NOT FOUND"}`);
    if (!asset) {
      return null; // caller treats a null return as "unusable" - see checkForMobileUpdate
    }
    // The manifest's numbers are the authority; GitHub's own asset size is
    // an equally exact stand-in for manifests published before `bytes`.
    const bytes = positiveInt(manifestChannel.bytes) ?? positiveInt(asset.size) ?? 0;
    const expect: UnzipExpectation = {};
    if (bytes > 0) {
      expect.bytes = bytes;
    }
    const entries = positiveInt(manifestChannel.entries);
    if (entries !== null) {
      expect.entries = entries;
    }
    result[channel] = {
      asset,
      version: manifestChannel.version,
      bytes,
      unpackedBytes: positiveInt(manifestChannel.unpackedBytes) ?? undefined,
      expect,
    };
  }

  return result;
}

// fetchJson is only ever called with a GitHub release asset's
// browser_download_url (the OTA manifest) - see capacitorHttp()'s doc
// comment for why that needs CapacitorHttp instead of fetch(). This
// module's own fetchAllReleases() talks to api.github.com directly instead
// (no redirect involved there), which fetch() already handles fine - left
// alone.
async function fetchJson<T>(url: string): Promise<T> {
  const http = capacitorHttp();
  if (!http) {
    throw new Error("CapacitorHttp plugin not available.");
  }
  const response = await http.request({ url, method: "GET", responseType: "json" });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.data as T;
}

/**
 * Checks for an applicable update and classifies which path applies. Returns
 * null when already up to date, the platform isn't Android/iOS, or the
 * check itself fails (offline, GitHub API unreachable) - same "fail
 * silently, try again next launch" behavior as update-check-api.ts.
 */
export async function checkForMobileUpdate(installedVersion: string, installedBuildNumber: number): Promise<MobileUpdateCheckResult | null> {
  console.log(`[mobile-updater] checkForMobileUpdate(${installedVersion}, ${installedBuildNumber}) called`);
  const plat = platform();
  console.log(`[mobile-updater] platform() = ${plat}`);
  if (!plat) {
    console.log(`[mobile-updater] no platform (not Capacitor) - bailing out, returning null`);
    return null;
  }

  try {
    const releases = await fetchCandidateReleases();
    const release = findApplicableRelease(releases, installedVersion, installedBuildNumber);
    if (!release) {
      console.log(`[mobile-updater] no applicable release found - already up to date, or nothing matched - returning null`);
      return null;
    }
    console.log(`[mobile-updater] applicable release: ${release.version}+${release.buildNumber}, assets:`, release.assets.map(a => a.name));

    const manifestAssetName = `PokeRogueOffline-${plat === "android" ? "Android" : "iOS"}-ota-manifest.json`;
    const manifestAsset = findAsset(release.assets, manifestAssetName);
    console.log(`[mobile-updater] looking for manifest asset "${manifestAssetName}" -> ${manifestAsset ? "found" : "NOT FOUND"}`);

    const installedFingerprint = getInstalledNativeFingerprint();
    console.log(`[mobile-updater] getInstalledNativeFingerprint() = ${installedFingerprint}`);

    let manifest: OtaManifest | null = null;
    if (manifestAsset && installedFingerprint !== null) {
      console.log(`[mobile-updater] fetching manifest from ${manifestAsset.browser_download_url}`);
      manifest = await fetchJson<OtaManifest>(manifestAsset.browser_download_url);
      console.log(`[mobile-updater] manifest fetched:`, manifest);
    } else {
      console.log(
        `[mobile-updater] NOT fetching manifest (manifestAsset=${!!manifestAsset}, installedFingerprint!==null=${installedFingerprint !== null}) - manifest stays null`,
      );
    }

    // Dev builds only ever apply dev-channel manifests - belt-and-suspenders
    // alongside the dev-/non-dev tag pattern split above. schemaVersion is
    // checked here too (fail closed on anything but the v2 shape this
    // module knows how to read) rather than guessing at an unknown shape.
    const expectedChannel = isScoomDev ? "dev" : "stable";
    const manifestUsable = manifest !== null && manifest.schemaVersion === 2 && manifest.channel === expectedChannel;
    console.log(
      `[mobile-updater] manifestUsable=${manifestUsable} (manifest!==null=${manifest !== null}, schemaVersion=${manifest?.schemaVersion}, manifest?.channel="${manifest?.channel}" vs expected "${expectedChannel}")`,
    );

    const otaMatches = manifestUsable && installedFingerprint !== null && manifest!.nativeFingerprint === installedFingerprint;
    console.log(
      `[mobile-updater] otaMatches=${otaMatches} (manifest.nativeFingerprint="${manifest?.nativeFingerprint}" vs installedFingerprint="${installedFingerprint}")`,
    );

    if (otaMatches) {
      if (plat === "ios" && !IOS_OTA_CONFIRMED) {
        console.log(`[mobile-updater] plat=ios and IOS_OTA_CONFIRMED=false - falling back to native-ios-notify-only`);
        return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" };
      }

      const otaChannels = await resolveOtaChannels(plat, release.assets, manifest!);
      if (!otaChannels) {
        console.log(`[mobile-updater] resolveOtaChannels failed (missing asset for a needed channel) - returning null`);
        return null;
      }
      console.log(`[mobile-updater] returning kind="ota", channels:`, Object.keys(otaChannels));
      return {
        version: release.version,
        buildNumber: release.buildNumber,
        kind: "ota",
        otaChannels,
      };
    }

    if (plat === "android") {
      const apkAsset = findAsset(release.assets, isScoomDev ? "PokeRogueOffline-dev.apk" : "PokeRogueOffline.apk");
      if (!apkAsset) {
        console.log(`[mobile-updater] android fallback: apkAsset not found - treating as notify-only`);
        return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" }; // nothing we can offer - treat as notify-only
      }
      console.log(`[mobile-updater] returning kind="native-android"`);
      return { version: release.version, buildNumber: release.buildNumber, kind: "native-android", apkAsset };
    }

    console.log(`[mobile-updater] falling through to kind="native-ios-notify-only"`);
    return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" };
  } catch (err) {
    // Offline or GitHub API unreachable - fail silently, try again next launch.
    console.error(`[mobile-updater] checkForMobileUpdate threw, returning null:`, err);
    return null;
  }
}

// ── Download ────────────────────────────────────────────────────────────

let activeDownloadController: AbortController | null = null;
let stagedOtaChannelPaths: Partial<Record<ChannelName, string>> = {};
let stagedApkPath: string | null = null;

/** One file the update downloads: an OTA channel zip, or the APK. */
export interface MobileDownloadItem {
  /** "code" | "assets" | "locales" for OTA channels, "apk" for the Android installer. */
  id: ChannelName | "apk";
  /** Total size in bytes; 0 when not known up front. */
  bytes: number;
}

export interface MobileDownloadProgress {
  /** Which item this progress is for - see describeMobileDownload(). */
  id: ChannelName | "apk";
  /** Position of that item in the download order, from 0. */
  index: number;
  /** Bytes of this item received so far. */
  received: number;
  /** Total bytes of this item; 0 when unknown. */
  total: number;
}

/** Everything downloadMobileUpdate() will fetch for this result, in order, with sizes - for showing progress per file. */
export function describeMobileDownload(result: MobileUpdateCheckResult): MobileDownloadItem[] {
  if (result.kind === "ota") {
    return CHANNELS.filter(channel => result.otaChannels?.[channel]).map(channel => ({ id: channel, bytes: result.otaChannels![channel]!.bytes }));
  }
  if (result.kind === "native-android" && result.apkAsset) {
    return [{ id: "apk", bytes: positiveInt(result.apkAsset.size) ?? 0 }];
  }
  return [];
}

const OTA_DOWNLOAD_PREFIX = "ota-download-";
const APK_DOWNLOAD_PREFIX = "update-";

/** Deletes a downloaded file by the URI downloadToFile() returned. Never throws. */
async function deleteDownloaded(uri: string | null | undefined): Promise<void> {
  if (!uri) {
    return;
  }
  try {
    await filesystem()?.deleteFile({ path: uri });
  } catch {
    // already gone, or not ours to delete - nothing useful to do about it
  }
}

/**
 * Removes update downloads left in the cache directory by an earlier
 * launch: a download that was interrupted, zips whose apply was cut short,
 * or an APK that has already been handed to the installer. Only runs at
 * boot, when no download of this launch can exist yet.
 */
async function sweepStaleDownloads(): Promise<void> {
  const fs = filesystem();
  if (!fs) {
    return;
  }
  try {
    const { files } = await fs.readdir({ path: "", directory: "CACHE" });
    for (const file of files ?? []) {
      const name: string = typeof file === "string" ? file : file?.name;
      if (!name) {
        continue;
      }
      const isOtaZip = name.startsWith(OTA_DOWNLOAD_PREFIX) && name.endsWith(".zip");
      const isApk = name.startsWith(APK_DOWNLOAD_PREFIX) && name.endsWith(".apk");
      if (isOtaZip || isApk) {
        await fs.deleteFile({ path: name, directory: "CACHE" }).catch(() => {});
      }
    }
  } catch {
    // cache directory unreadable - nothing to sweep
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Refuses to start a download that cannot fit. For OTA the peak is every
 * channel zip plus every channel unzipped (see estimateRequiredBytes); for
 * the APK it is the file itself. Skipped - never failed - when the free
 * space or any size is unknown: this is a courtesy check, and must not be
 * able to block an update on its own inability to measure.
 */
async function assertEnoughFreeSpace(result: MobileUpdateCheckResult): Promise<void> {
  let required: number;
  if (result.kind === "ota") {
    const sizes: ChannelSize[] = [];
    for (const update of Object.values(result.otaChannels ?? {})) {
      if (!update || update.bytes <= 0) {
        return;
      }
      sizes.push({ bytes: update.bytes, unpackedBytes: update.unpackedBytes });
    }
    required = estimateRequiredBytes(sizes);
  } else {
    required = positiveInt(result.apkAsset?.size) ?? 0;
  }
  if (required <= 0) {
    return;
  }
  const free = await getFreeBytes();
  if (free === null) {
    return;
  }
  console.log(`[mobile-updater] free-space check: need ~${required} bytes, ${free} free`);
  if (free < required) {
    throw new Error(`Not enough free storage for this update: about ${formatMb(required)} needed, ${formatMb(free)} available.`);
  }
}

/**
 * Downloads `url` straight to a file in app-private cache storage via
 * @capacitor/file-transfer (see fileTransfer()'s doc comment for why - the
 * same CORS wall CapacitorHttp sidesteps for small fetches). Returns only
 * the native path - earlier versions of this function also read the whole
 * file straight back into JS (to verify a checksum, then to unzip it), which
 * meant base64-encoding and holding the ENTIRE file - 500MB+ for the OTA
 * bundle - in memory at once. That's almost certainly what was crashing the
 * WKWebView process mid-update (confirmed on-device: the download completed,
 * then the app reloaded with none of the staging ever having logged, which
 * only fits a content-process kill-and-recover, not a real finish). Checksum
 * verification is dropped entirely now (trusting the HTTPS transport
 * instead - a deliberate choice, not an oversight); what IS checked,
 * natively and without reading the file, is that the zip has exactly the
 * size the release says and unzips to exactly the number of entries the
 * manifest says (see the OtaUnzip plugin) - enough to catch a truncated
 * download, which is the failure HTTPS does not rule out.
 *
 * `signal`: FileTransfer.downloadFile() has no native cancellation hook, so
 * aborting here only stops this call from waiting on it - the native
 * download may keep running in the background until it finishes on its own.
 * Best-effort, same as the rest of this module's "cancel" semantics.
 */
async function downloadToFile(
  url: string,
  relPath: string,
  onProgress: (p: { received: number; total: number }) => void,
  signal: AbortSignal,
): Promise<string> {
  const ft = fileTransfer();
  const fs = filesystem();
  if (!ft || !fs) {
    throw new Error("Capacitor FileTransfer/Filesystem plugin not available.");
  }

  const { uri } = await fs.getUri({ path: relPath, directory: "CACHE" });

  const listenerHandle = await ft.addListener("progress", (status: { url: string; bytes: number; contentLength: number }) => {
    if (status.url === url) {
      onProgress({ received: status.bytes, total: status.contentLength });
    }
  });

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    await Promise.race([ft.downloadFile({ url, path: uri, progress: true }), abortPromise]);
  } catch (err) {
    await deleteDownloaded(uri); // don't leave a partial file behind
    throw err;
  } finally {
    listenerHandle.remove();
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return uri;
}

/** Downloads (never activates - see applyMobileUpdateAndRelaunch) whatever checkForMobileUpdate() last found applicable. */
export async function downloadMobileUpdate(result: MobileUpdateCheckResult, onProgress: (p: MobileDownloadProgress) => void, signal: AbortSignal): Promise<void> {
  console.log(`[mobile-updater] downloadMobileUpdate() called with kind="${result.kind}"`);
  if (result.kind === "native-ios-notify-only") {
    throw new Error("No downloadable update for this platform/release.");
  }

  await assertEnoughFreeSpace(result);

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });
  activeDownloadController = controller;

  const items = describeMobileDownload(result);

  try {
    if (result.kind === "ota") {
      await discardStagedOtaDownloads();
      // Sequential, one channel at a time. Progress is reported per file
      // (which file, how much of it), so the UI can show every file's own
      // size and progress rather than one bar that resets per channel.
      try {
        for (const [index, item] of items.entries()) {
          const channel = item.id as ChannelName;
          const update = result.otaChannels![channel]!;
          const path = await downloadToFile(
            update.asset.browser_download_url,
            `${OTA_DOWNLOAD_PREFIX}${channel}-${result.version}-${result.buildNumber}.zip`,
            ({ received, total }) => onProgress({ id: channel, index, received, total: item.bytes || total }),
            controller.signal,
          );
          console.log(`[mobile-updater] downloadMobileUpdate: downloaded ${channel} to ${path}, staged`);
          stagedOtaChannelPaths[channel] = path;
          if (item.bytes > 0) {
            onProgress({ id: channel, index, received: item.bytes, total: item.bytes });
          }
        }
      } catch (err) {
        await discardStagedOtaDownloads(); // a partial set is useless - free the space
        throw err;
      }
      return;
    }

    // native-android: download the real APK into app-private cache storage,
    // then hand the path straight to installApk() - no read-back needed here
    // at all, since there's nothing in JS that needs the APK's bytes.
    await deleteDownloaded(stagedApkPath);
    stagedApkPath = null;
    const apkBytes = items[0]?.bytes ?? 0;
    stagedApkPath = await downloadToFile(
      result.apkAsset!.browser_download_url,
      `${APK_DOWNLOAD_PREFIX}${result.version}-${result.buildNumber}.apk`,
      ({ received, total }) => onProgress({ id: "apk", index: 0, received, total: apkBytes || total }),
      controller.signal,
    );
  } finally {
    signal.removeEventListener("abort", forwardAbort);
    activeDownloadController = null;
  }
}

/** Deletes every downloaded-but-not-applied channel zip and forgets it. */
async function discardStagedOtaDownloads(): Promise<void> {
  const paths = Object.values(stagedOtaChannelPaths);
  stagedOtaChannelPaths = {};
  for (const path of paths) {
    await deleteDownloaded(path);
  }
}

export function cancelMobileDownload(): void {
  activeDownloadController?.abort();
}

// ── Activation and rollback (OTA path only) ─────────────────────────────
//
// The actual per-channel stage/swap/rollback logic lives in ota-core.ts
// (via ota-parts.ts) - this module only orchestrates which channels got
// downloaded and when to call into it, plus the setBasePath/session-reapply
// plumbing below.

/** OTA (either platform): bootstraps or incrementally applies whichever channels were downloaded, then reloads. Android native fallback: hands the downloaded APK to the system installer (does not install anything itself). iOS notify-only (native-touching releases only): always rejects. */
export async function applyMobileUpdateAndRelaunch(result: MobileUpdateCheckResult): Promise<void> {
  console.log(`[mobile-updater] applyMobileUpdateAndRelaunch() called with kind="${result.kind}"`);
  if (result.kind === "ota") {
    if (!filesystem()) {
      throw new Error("Capacitor Filesystem plugin not available.");
    }
    const otaChannels = result.otaChannels ?? {};

    try {
      if (!(await isOtaBootstrapped())) {
        // First-ever OTA on this install - checkForMobileUpdate() guarantees
        // all three channels were downloaded for this case (see
        // resolveOtaChannels), so this is never a partial bootstrap.
        const zipPaths: Partial<Record<ChannelName, string>> = {};
        const versions: Partial<Record<ChannelName, string>> = {};
        const expectations: Partial<Record<ChannelName, UnzipExpectation>> = {};
        for (const channel of CHANNELS) {
          const update = otaChannels[channel];
          const path = stagedOtaChannelPaths[channel];
          if (!update || !path) {
            throw new Error(`Missing downloaded bootstrap channel "${channel}" - was downloadMobileUpdate() called first?`);
          }
          zipPaths[channel] = path;
          versions[channel] = update.version;
          expectations[channel] = update.expect;
        }
        await bootstrapActive(zipPaths as Record<ChannelName, string>, versions as Record<ChannelName, string>, expectations, getInstalledNativeFingerprint());
      } else {
        for (const channel of CHANNELS) {
          const update = otaChannels[channel];
          if (!update) {
            continue;
          }
          const path = stagedOtaChannelPaths[channel];
          if (!path) {
            throw new Error(`Missing downloaded channel "${channel}" - was downloadMobileUpdate() called first?`);
          }
          await applyChannelUpdate(channel, path, update.version, update.expect);
        }
      }
    } finally {
      // Applied or failed, the zips have served their purpose: everything
      // they contained is now unzipped under ota/, or the attempt is being
      // abandoned and a retry downloads afresh. Either way they are dead
      // weight (500MB+ for a first OTA) in the cache directory.
      await discardStagedOtaDownloads();
    }

    // Activate immediately - don't rely on the boot-hook reapply below to
    // do this on the NEXT launch, since this is the first time this
    // version's files exist at all and nothing has pointed the WebView at
    // them yet.
    await setBasePath(await getActiveDirUri());
    console.log(`[mobile-updater] applyMobileUpdateAndRelaunch: staged+activated, reloading now`);
    window.location.reload();
    return;
  }

  if (result.kind === "native-android") {
    if (!stagedApkPath) {
      throw new Error("No verified update staged to apply.");
    }
    const bridge = otaBridge();
    if (!bridge) {
      throw new Error("OtaBridge plugin not available.");
    }
    await bridge.installApk({ path: stagedApkPath });
    // Hands off to Android's installer UI here - this process doesn't
    // control what happens next, the OS does. The APK has to stay on disk
    // while the installer reads it; sweepStaleDownloads() removes it on the
    // next launch.
    return;
  }

  throw new Error("No in-app update mechanism for this platform/release.");
}

// Guards reapplyActiveOtaBundleIfAny()'s setBasePath() call against being called more
// than once per real app launch. Both platforms' native setServerBasePath
// unconditionally forces an immediate WebView reload every single call - confirmed
// directly against Capacitor's real source for both: iOS's
// CAPBridgeViewController.setServerBasePath(path:) always does
// `webView.load(URLRequest(url: ...))` right after calling into the bridge; Android's
// Bridge.setServerBasePath(String) always does `webView.post(() -> webView.loadUrl(
// appUrl))`. Since this function runs synchronously as part of main.ts's own module
// evaluation, calling it again on every boot (including whatever boot results from
// that very reload) created an infinite call->reload->call loop - confirmed on-device
// (bootAttempts climbing past 100, "Importing a module script failed" from the forced
// reload cutting off the page's own in-flight module loading). sessionStorage is the
// right primitive here: it survives a WebView content reload within the same native
// app process (so a reload caused by our own setBasePath call doesn't re-trigger it)
// but is cleared on a genuine app relaunch (so a real cold launch still re-applies
// the pointer exactly once, as intended).
//
// Unlike the old single-bundle version, there's now only ONE possible
// served path (ota/active/, shared by all three channels), so the guard
// is a plain boolean instead of a path comparison.
const OTA_REAPPLIED_SESSION_KEY = "mobile-updater:reapplied";
// Set once per launch when the OTA content's own JS has run (see below).
const OTA_LOAD_MARKED_SESSION_KEY = "mobile-updater:load-marked";

/**
 * Boot hook - call once, early, on every cold launch (gated on
 * Capacitor.isNativePlatform()). Delegates the actual per-channel
 * recovery/reapply/rollback bookkeeping to ota-parts.ts's
 * reapplyActivePartsIfAny(); this wrapper owns the session guard above
 * setBasePath, and the "the new content's JS ran" signal.
 *
 * The session flag is only set when reapplyActivePartsIfAny() reports it
 * actually called setBasePath - NOT unconditionally after calling it. A
 * truly fresh install (no OTA ever applied yet) has nothing to reapply,
 * so that call legitimately does nothing; marking the session "reapplied"
 * anyway would wrongly skip a REAL reapply later in the same session
 * (e.g. right after applyMobileUpdateAndRelaunch's own reload, which runs
 * this same boot hook again on the same WebView process) - this is
 * exactly what caused a bootstrap OTA to silently fail to activate until
 * a manual force-close/reopen, confirmed on-device.
 *
 * NOTE: this only runs from JS (patches/all/node/mobile-ota-updater.js's
 * main.ts hook), which means it only executes AFTER the WebView has already
 * loaded its initial page from whatever base path was active at launch - and, per the
 * OTA_REAPPLIED_SESSION_KEY guard above, calling setBasePath() here forces exactly one
 * extra reload per real cold launch to switch over, never more.
 *
 * That same structure gives the rollback logic its "did the new content
 * get to run at all" signal for free: this function finding the session
 * flag already set means it is being called by the page that loaded AFTER
 * the switch - i.e. by the OTA content's own main.ts. A launch that gets
 * that far and is then closed before the title screen (slow first load,
 * impatient user) is counted separately from one where the new content
 * never ran, and is given more chances before the update is rolled back -
 * see ota-core.ts's two thresholds.
 */
export async function reapplyActiveOtaBundleIfAny(): Promise<void> {
  try {
    if (sessionStorage.getItem(OTA_REAPPLIED_SESSION_KEY) === "1") {
      console.log(`[mobile-updater] reapplyActiveOtaBundleIfAny: already reapplied this session - skipping`);
      if (sessionStorage.getItem(OTA_LOAD_MARKED_SESSION_KEY) !== "1") {
        sessionStorage.setItem(OTA_LOAD_MARKED_SESSION_KEY, "1");
        await markPartsLoadReached().catch(err => console.error(`[mobile-updater] markPartsLoadReached failed:`, err));
      }
      return;
    }
  } catch {
    // sessionStorage unavailable - fall through and apply as normal.
  }

  await sweepStaleDownloads();

  const didActivate = await reapplyActivePartsIfAny(setBasePath, getInstalledNativeFingerprint());
  if (!didActivate) {
    return;
  }

  try {
    sessionStorage.setItem(OTA_REAPPLIED_SESSION_KEY, "1");
  } catch {
    // sessionStorage unavailable - nothing to do, the apply above still happened once.
  }
}

/** Call once gameplay/title-screen readiness is reached. Delegates to ota-parts.ts's confirmPartsBootSuccess() (confirms every unconfirmed channel, clears their backups). */
export async function confirmOtaBootSuccess(): Promise<void> {
  await confirmPartsBootSuccess();
}
