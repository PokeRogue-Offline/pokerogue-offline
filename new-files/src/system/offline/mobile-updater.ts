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
 * ── Atomic activation and rollback ───────────────────────────────────────
 * Each channel is staged into a scratch directory and only swapped into
 * the one served directory (`ota/active/`) after the stage is fully
 * written - never written into the currently-active content in place -
 * and a per-channel backup of what was there before is kept until the new
 * version proves it boots. This makes an interrupted OTA (app killed
 * mid-download, mid-write, disk full, or a channel that writes fine but
 * doesn't boot) structurally unable to leave the app unable to start: a
 * channel's pointer only ever names a version that was both fully staged
 * AND previously confirmed to boot (see reapplyActiveOtaBundleIfAny /
 * confirmOtaBootSuccess, which delegate to ota-parts.ts - see that file
 * for the full per-channel stage/backup/swap/rollback mechanics),
 * mirroring the same discipline updater.cjs already uses on desktop
 * (stage first, swap atomically, keep the previous version recoverable
 * until the new one proves itself).
 */

import { isScoomDev } from "#system/offline/scooom-dev";
import {
  applyChannelUpdate,
  bootstrapActive,
  CHANNELS,
  confirmPartsBootSuccess,
  getActiveDirUri,
  isOtaBootstrapped,
  readChannelPointer,
  reapplyActivePartsIfAny,
  type ChannelName,
} from "#system/offline/ota-parts";

const OWNER = "PokeRogue-Offline";
const REPO = "pokerogue-offline";
const RELEASES_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`;

const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:\.\d+)?)-(\d+)$/;
const DEV_TAG_PATTERN = /^dev-v(\d+\.\d+\.\d+(?:\.\d+)?)-(\d+)$/;

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

interface GhAsset {
  name: string;
  browser_download_url: string;
}

interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
}

interface OtaManifestChannel {
  version: string;
  sha256: string;
  assetName: string;
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

function tagPattern(): RegExp {
  return isScoomDev ? DEV_TAG_PATTERN : TAG_PATTERN;
}

function extractVersion(versionString: string): number[] {
  const regex = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
  if (!regex.test(versionString)) {
    throw new Error(`Invalid version string (${versionString}) in mobile updater!`);
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
  // Dev releases are always prerelease (never promoted) - dev-flagged builds
  // must NOT filter them out. Real builds' tag pattern can't match a
  // dev-prefixed tag anyway, but keep the prerelease filter for them too,
  // matching update-check-api.ts's/updater.cjs's existing convention
  // ("staged, not yet promoted" releases are hidden from real builds).
  return releases.filter(r => !r.draft && (isScoomDev || !r.prerelease));
}

interface MatchedRelease {
  version: string;
  buildNumber: number;
  assets: GhAsset[];
}

function findApplicableRelease(releases: GhRelease[], installedVersion: string, installedBuildNumber: number): MatchedRelease | null {
  const pattern = tagPattern();
  console.log(
    `[mobile-updater] findApplicableRelease: ${releases.length} release(s) fetched, isScoomDev=${isScoomDev}, pattern=${pattern}, installed=${installedVersion}+${installedBuildNumber}`,
  );
  const byVersion = new Map<string, MatchedRelease>();
  for (const release of releases) {
    const match = release.tag_name?.match(pattern);
    if (!match) {
      console.log(`[mobile-updater]   skip "${release.tag_name}" - doesn't match pattern`);
      continue;
    }
    const [, versionStr, buildStr] = match;
    const buildNumber = Number.parseInt(buildStr, 10);
    const existing = byVersion.get(versionStr);
    if (!existing || buildNumber > existing.buildNumber) {
      byVersion.set(versionStr, { version: versionStr, buildNumber, assets: release.assets || [] });
    }
  }
  console.log(`[mobile-updater]   matched tags, highest build per version:`, Object.fromEntries(byVersion));

  const applicable = Array.from(byVersion.values())
    .filter(r => {
      const cmp = compareVersions(r.version, installedVersion);
      return cmp === 1 || (cmp === 0 && r.buildNumber > installedBuildNumber);
    })
    .sort((a, b) => compareVersions(a.version, b.version) || a.buildNumber - b.buildNumber);

  const result = applicable.length > 0 ? applicable[applicable.length - 1] : null;
  console.log(`[mobile-updater]   applicable (newer than installed):`, applicable, `-> picked:`, result);
  return result;
}

function findAsset(assets: GhAsset[], name: string): GhAsset | undefined {
  return assets.find(a => a.name === name);
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
  const fs = filesystem();
  const bootstrapped = fs ? await isOtaBootstrapped(fs) : false;
  console.log(`[mobile-updater] resolveOtaChannels: bootstrapped=${bootstrapped}`);

  const platformName = plat === "android" ? "Android" : "iOS";
  const result: Partial<Record<ChannelName, MobileOtaChannelUpdate>> = {};

  for (const channel of CHANNELS) {
    const manifestChannel = manifest[channel];
    let needed = !bootstrapped; // first-ever OTA needs all three, regardless of version comparison
    if (!needed) {
      const installedPointer = fs ? await readChannelPointer(fs, channel) : null;
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
    result[channel] = { asset, version: manifestChannel.version };
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
    const releases = await fetchAllReleases();
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

// ── Download + verify ───────────────────────────────────────────────────

let activeDownloadController: AbortController | null = null;
let stagedOtaChannelPaths: Partial<Record<ChannelName, string>> = {};
let stagedApkPath: string | null = null;

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
 * instead - a deliberate choice, not an oversight), and ota-parts.ts's
 * bootstrapActive()/applyChannelUpdate() unzip the downloaded zip via
 * native code (configs/capacitor-plugins/ota-unzip) instead of ever
 * loading it whole into JS.
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

  const abortPromise = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });

  try {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    await Promise.race([ft.downloadFile({ url, path: uri, progress: true }), abortPromise]);
  } finally {
    listenerHandle.remove();
  }

  return uri;
}

/** Downloads (never activates - see applyMobileUpdateAndRelaunch) whatever checkForMobileUpdate() last found applicable. */
export async function downloadMobileUpdate(result: MobileUpdateCheckResult, onProgress: (p: { received: number; total: number }) => void, signal: AbortSignal): Promise<void> {
  console.log(`[mobile-updater] downloadMobileUpdate() called with kind="${result.kind}"`);
  if (result.kind === "native-ios-notify-only") {
    throw new Error("No downloadable update for this platform/release.");
  }

  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort());
  activeDownloadController = controller;

  try {
    if (result.kind === "ota") {
      stagedOtaChannelPaths = {};
      // Sequential, one channel at a time - simpler than merging progress
      // across parallel downloads, and channel zips are each far smaller
      // than the old single combined bundle, so there's no strong reason
      // to parallelize. onProgress resets to 0 at the start of each
      // channel's download rather than reporting one running total across
      // all of them - a deliberate simplification, not an oversight.
      for (const [channel, update] of Object.entries(result.otaChannels ?? {}) as [ChannelName, MobileOtaChannelUpdate][]) {
        const path = await downloadToFile(update.asset.browser_download_url, `ota-download-${channel}-${result.version}-${result.buildNumber}.zip`, onProgress, controller.signal);
        console.log(`[mobile-updater] downloadMobileUpdate: downloaded ${channel} to ${path}, staged`);
        stagedOtaChannelPaths[channel] = path;
      }
      return;
    }

    // native-android: download the real APK into app-private cache storage,
    // then hand the path straight to installApk() - no read-back needed here
    // at all, since there's nothing in JS that needs the APK's bytes.
    stagedApkPath = await downloadToFile(
      result.apkAsset!.browser_download_url,
      `update-${result.version}-${result.buildNumber}.apk`,
      onProgress,
      controller.signal,
    );
  } finally {
    activeDownloadController = null;
  }
}

export function cancelMobileDownload(): void {
  activeDownloadController?.abort();
}

// ── Atomic activation and rollback (OTA path only) ──────────────────────
//
// The actual per-channel stage/swap/rollback logic (and why it needs no
// composed-directory native plugin) lives in ota-parts.ts - this module
// only orchestrates which channels got downloaded and when to call into
// it, plus the setBasePath/session-reapply plumbing already in place
// below.

/** OTA (either platform): bootstraps or incrementally applies whichever channels were downloaded, then reloads. Android native fallback: hands the downloaded APK to the system installer (does not install anything itself). iOS notify-only (native-touching releases only): always rejects. */
export async function applyMobileUpdateAndRelaunch(result: MobileUpdateCheckResult): Promise<void> {
  console.log(`[mobile-updater] applyMobileUpdateAndRelaunch() called with kind="${result.kind}"`);
  if (result.kind === "ota") {
    const fs = filesystem();
    if (!fs) {
      throw new Error("Capacitor Filesystem plugin not available.");
    }
    const otaChannels = result.otaChannels ?? {};

    if (!(await isOtaBootstrapped(fs))) {
      // First-ever OTA on this install - checkForMobileUpdate() guarantees
      // all three channels were downloaded for this case (see
      // resolveOtaChannels), so this is never a partial bootstrap.
      const zipPaths: Partial<Record<ChannelName, string>> = {};
      const versions: Partial<Record<ChannelName, string>> = {};
      for (const channel of CHANNELS) {
        const update = otaChannels[channel];
        const path = stagedOtaChannelPaths[channel];
        if (!update || !path) {
          throw new Error(`Missing downloaded bootstrap channel "${channel}" - was downloadMobileUpdate() called first?`);
        }
        zipPaths[channel] = path;
        versions[channel] = update.version;
      }
      await bootstrapActive(zipPaths as Record<ChannelName, string>, versions as Record<ChannelName, string>);
    } else {
      for (const [channel, update] of Object.entries(otaChannels) as [ChannelName, MobileOtaChannelUpdate][]) {
        const path = stagedOtaChannelPaths[channel];
        if (!path) {
          throw new Error(`Missing downloaded channel "${channel}" - was downloadMobileUpdate() called first?`);
        }
        await applyChannelUpdate(channel, path, update.version);
      }
    }

    // Activate immediately - don't rely on the boot-hook reapply below to
    // do this on the NEXT launch, since this is the first time this
    // version's files exist at all and nothing has pointed the WebView at
    // them yet. Mirrors the original single-bundle code's
    // stageAndActivateOta(), which called setBasePath directly here too.
    await setBasePath(await getActiveDirUri(fs));
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
    // control what happens next, the OS does.
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

/**
 * Boot hook - call once, early, on every cold launch (gated on
 * Capacitor.isNativePlatform()). Delegates the actual per-channel
 * reapply/rollback bookkeeping to ota-parts.ts's reapplyActivePartsIfAny();
 * this wrapper's only job is the session-guard above setBasePath.
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
 * NOTE: this only runs from JS (patches/mobile/node/mobile-ota-updater.js's
 * main.ts hook), which means it only executes AFTER the WebView has already
 * loaded its initial page from whatever base path was active at launch - and, per the
 * OTA_REAPPLIED_SESSION_KEY guard above, calling setBasePath() here forces exactly one
 * extra reload per real cold launch to switch over, never more.
 */
export async function reapplyActiveOtaBundleIfAny(): Promise<void> {
  try {
    if (sessionStorage.getItem(OTA_REAPPLIED_SESSION_KEY) === "1") {
      console.log(`[mobile-updater] reapplyActiveOtaBundleIfAny: already reapplied this session - skipping`);
      return;
    }
  } catch {
    // sessionStorage unavailable - fall through and apply as normal.
  }

  const didActivate = await reapplyActivePartsIfAny(setBasePath);
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
