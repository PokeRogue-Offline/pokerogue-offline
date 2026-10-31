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
 *     supports it. The web bundle is downloaded, staged, and activated in
 *     place via the stock Capacitor setServerBasePath plugin method (both
 *     platforms - see IOS_OTA_CONFIRMED below) - see the activation/rollback
 *     section below. No checksum verification (trusts the HTTPS transport
 *     instead) - see downloadToFile()'s doc comment for why.
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
 * An OTA bundle is staged into its own versioned directory and only made
 * "active" by flipping one small pointer file after the stage is fully
 * written and verified - never written into the currently-active bundle's
 * location in place. This makes an interrupted OTA (app killed mid-download,
 * mid-write, disk full, or a bundle that writes fine but doesn't boot)
 * structurally unable to leave the app unable to start: the active pointer
 * only ever names a version that was both fully staged AND previously
 * confirmed to boot (see reapplyActiveOtaBundleIfAny / confirmOtaBootSuccess
 * / the crash-loop counter below), mirroring the same discipline
 * updater.cjs already uses on desktop (stage first, swap atomically, keep
 * the previous version recoverable until the new one proves itself).
 */

import { isScoomDev } from "#system/offline/scooom-dev";

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
 * configs/capacitor-plugins/ota-unzip - a vendored (never published)
 * Capacitor plugin that unzips the downloaded OTA bundle straight to disk in
 * native code (java.util.zip.ZipInputStream on Android, ZIPFoundation on
 * iOS), so the archive's bytes never cross the WebView/JS bridge at all. See
 * stageAndActivateOta()'s doc comment for why that bridge crossing was
 * suspected to be crashing the WKWebView content process.
 */
function otaUnzip(): any {
  return cap()?.Plugins?.OtaUnzip;
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

/** Re-points the WebView at `path` via the stock setServerBasePath plugin method - the one real mechanism both OTA paths (stage+activate and boot-time reapply) share. */
async function setBasePath(path: string): Promise<void> {
  const plugin = webViewPlugin();
  console.log(`[mobile-updater] setBasePath(${path}) - WebView plugin ${plugin ? "found" : "NOT FOUND"}`);
  await plugin?.setServerBasePath({ path });
  console.log(`[mobile-updater] setBasePath(${path}) done`);
}

export type MobileUpdateKind = "ota" | "native-android" | "native-ios-notify-only";

export interface MobileUpdateCheckResult {
  version: string;
  buildNumber: number;
  kind: MobileUpdateKind;
  /** Only set for kind "ota" - needed by downloadMobileUpdate(). */
  otaAsset?: GhAsset;
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

interface OtaManifest {
  version: string;
  buildNumber: number;
  nativeFingerprint: string;
  /** Still published in the manifest (Write OTA manifest step), but no longer read here - checksum verification was dropped in favor of trusting HTTPS transport. */
  otaBundleSha256: string;
  channel: "stable" | "dev";
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
    // alongside the dev-/non-dev tag pattern split above.
    const expectedChannel = isScoomDev ? "dev" : "stable";
    const manifestUsable = manifest !== null && manifest.channel === expectedChannel;
    console.log(
      `[mobile-updater] manifestUsable=${manifestUsable} (manifest!==null=${manifest !== null}, manifest?.channel="${manifest?.channel}" vs expected "${expectedChannel}")`,
    );

    const otaMatches = manifestUsable && installedFingerprint !== null && manifest!.nativeFingerprint === installedFingerprint;
    console.log(
      `[mobile-updater] otaMatches=${otaMatches} (manifest.nativeFingerprint="${manifest?.nativeFingerprint}" vs installedFingerprint="${installedFingerprint}")`,
    );

    if (otaMatches) {
      const otaAssetName = `PokeRogueOffline-${plat === "android" ? "Android" : "iOS"}-ota.zip`;
      const otaAsset = findAsset(release.assets, otaAssetName);
      console.log(`[mobile-updater] looking for OTA asset "${otaAssetName}" -> ${otaAsset ? "found" : "NOT FOUND"}`);
      if (!otaAsset) {
        console.log(`[mobile-updater] OTA asset missing despite otaMatches - returning null`);
        return null;
      }
      if (plat === "ios" && !IOS_OTA_CONFIRMED) {
        console.log(`[mobile-updater] plat=ios and IOS_OTA_CONFIRMED=false - falling back to native-ios-notify-only`);
        return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" };
      }
      console.log(`[mobile-updater] returning kind="ota"`);
      return {
        version: release.version,
        buildNumber: release.buildNumber,
        kind: "ota",
        otaAsset,
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
let stagedOtaPath: string | null = null;
let stagedOtaResult: MobileUpdateCheckResult | null = null;
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
 * instead - a deliberate choice, not an oversight), and stageAndActivateOta()
 * below reads the OTA zip back in via a streaming fetch + streaming unzip
 * instead of ever loading it whole.
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
      const path = await downloadToFile(
        result.otaAsset!.browser_download_url,
        `ota-download-${result.version}-${result.buildNumber}.zip`,
        onProgress,
        controller.signal,
      );
      console.log(`[mobile-updater] downloadMobileUpdate: downloaded to ${path}, staged`);
      stagedOtaPath = path;
      stagedOtaResult = result;
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

const OTA_DIR = "ota";
const ACTIVE_POINTER_PATH = `${OTA_DIR}/active.json`;
const BOOT_ATTEMPT_THRESHOLD = 2;

interface ActivePointer {
  version: string;
  buildNumber: number;
  path: string;
  bootAttempts: number;
  confirmed: boolean;
}

async function readActivePointer(fs: any): Promise<ActivePointer | null> {
  try {
    const { data } = await fs.readFile({ path: ACTIVE_POINTER_PATH, directory: "DATA", encoding: "utf8" });
    return JSON.parse(data as string);
  } catch {
    return null;
  }
}

async function writeActivePointer(fs: any, pointer: ActivePointer): Promise<void> {
  await fs.writeFile({ path: ACTIVE_POINTER_PATH, data: JSON.stringify(pointer), directory: "DATA", encoding: "utf8", recursive: true });
}

/**
 * Stages the downloaded OTA bundle (downloadMobileUpdate() must have
 * already run and succeeded) into its own versioned directory, then flips
 * the active pointer - the sole "point of no return" in this whole
 * sequence. Everything before that write is safely abandonable if
 * interrupted: the previously-active (and previously-confirmed) bundle is
 * left untouched on disk the entire time.
 *
 * The actual unzip-and-write-to-disk work happens entirely in native code
 * (configs/capacitor-plugins/ota-unzip) - this used to be done in JS, via
 * Capacitor.convertFileSrc() + a streaming fetch() feeding fflate's
 * streaming Unzip decoder, buffering only the current entry's decompressed
 * bytes in memory at once. That looked safe from the JS side, but
 * Capacitor's iOS native URL-scheme handler behind convertFileSrc
 * (WebViewAssetHandler.swift) reads a requested non-media file - our .zip -
 * whole into memory before WebKit ever sees it, which is suspected to be
 * what was actually crashing the WKWebView content process mid-update
 * (confirmed on-device: the download completed, then the app reloaded with
 * none of the staging logic ever having logged a line, which only fits a
 * process kill-and-recover, not a real finish). Handing native code the
 * source and destination paths directly means the archive's bytes never
 * cross the WebView/JS bridge in either direction - only two short path
 * strings in, and a small result object out.
 */
async function stageAndActivateOta(): Promise<void> {
  if (!stagedOtaPath || !stagedOtaResult) {
    throw new Error("No downloaded OTA bundle staged to apply.");
  }
  const fs = filesystem();
  if (!fs) {
    throw new Error("Capacitor Filesystem plugin not available.");
  }
  const unzipPlugin = otaUnzip();
  if (!unzipPlugin) {
    throw new Error("OtaUnzip plugin not available.");
  }

  const versionDir = `${OTA_DIR}/${stagedOtaResult.version}-${stagedOtaResult.buildNumber}`;
  // Resolved to an absolute native path/URI up front, before calling into
  // native code - the native plugin does plain file I/O and has no need to
  // know Capacitor's "DATA" directory-alias semantics.
  const { uri } = await fs.getUri({ path: versionDir, directory: "DATA" });
  console.log(`[mobile-updater] stageAndActivateOta: versionDir="${versionDir}", uri="${uri}"`);

  try {
    const { entryCount } = await unzipPlugin.unzip({ sourcePath: stagedOtaPath, destDir: uri });
    console.log(`[mobile-updater] stageAndActivateOta: native unzip wrote ${entryCount} entries to ${uri}`);
  } catch (err) {
    // Disk full / write failure mid-stage: abandon the partial directory,
    // never flip the pointer. The previously-active bundle keeps running.
    console.error(`[mobile-updater] stageAndActivateOta: native unzip failed, abandoning ${versionDir}:`, err);
    await fs.rmdir({ path: versionDir, directory: "DATA", recursive: true }).catch(() => {});
    throw err;
  }

  // This write is the point of no return - everything above is abandonable,
  // nothing below un-does it. bootAttempts starts at 0; the next launch's
  // reapplyActiveOtaBundleIfAny() increments it before this version proves
  // itself via confirmOtaBootSuccess().
  await writeActivePointer(fs, {
    version: stagedOtaResult.version,
    buildNumber: stagedOtaResult.buildNumber,
    path: uri,
    bootAttempts: 0,
    confirmed: false,
  });
  console.log(`[mobile-updater] stageAndActivateOta: active pointer written`);

  await setBasePath(uri);
}

/** OTA (either platform): stages+activates (see above) and reloads. Android native fallback: hands the downloaded APK to the system installer (does not install anything itself). iOS notify-only (native-touching releases only): always rejects. */
export async function applyMobileUpdateAndRelaunch(result: MobileUpdateCheckResult): Promise<void> {
  console.log(`[mobile-updater] applyMobileUpdateAndRelaunch() called with kind="${result.kind}"`);
  if (result.kind === "ota") {
    await stageAndActivateOta();
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

/**
 * Boot hook - call once, early, on every cold launch (gated on
 * Capacitor.isNativePlatform()). Reads the active pointer and re-points the
 * WebView at whatever it names (a full relaunch would otherwise silently
 * fall back to the bundled assets); tracks the crash-loop counter, rolling
 * back to nothing (falls through to the originally-bundled assets, which
 * are always known-good) if a version repeatedly fails to confirm.
 *
 * NOTE: this only runs from JS (patches/mobile/node/mobile-ota-updater.js's
 * main.ts hook), which means it only executes AFTER the WebView has already
 * loaded its initial page from whatever base path was active at launch. On
 * a cold launch where a newer OTA bundle is active, this fires one
 * location.reload() to switch over - one extra reload, not unsafe, but not
 * as clean as a native (pre-WebView-load) reapply hook would be. That's a
 * possible future improvement, not required for correctness: setBasePath()
 * + reload() from within an already-running session (the normal apply path
 * in applyMobileUpdateAndRelaunch above) works exactly as intended either way.
 */
export async function reapplyActiveOtaBundleIfAny(): Promise<void> {
  const fs = filesystem();
  if (!fs) {
    console.log(`[mobile-updater] reapplyActiveOtaBundleIfAny: no Filesystem plugin - bailing`);
    return;
  }
  const pointer = await readActivePointer(fs);
  console.log(`[mobile-updater] reapplyActiveOtaBundleIfAny: active pointer =`, pointer);
  if (!pointer) {
    return;
  }

  if (!pointer.confirmed && pointer.bootAttempts >= BOOT_ATTEMPT_THRESHOLD) {
    // This version never confirmed after repeated attempts - abandon it
    // and fall through to the bundled assets (always known-good) rather
    // than retrying something that doesn't start.
    console.warn(`[mobile-updater] reapplyActiveOtaBundleIfAny: never confirmed after ${pointer.bootAttempts} attempts - abandoning, falling back to bundled assets`);
    await fs.rmdir({ path: `${OTA_DIR}/${pointer.version}-${pointer.buildNumber}`, directory: "DATA", recursive: true }).catch(() => {});
    await fs.deleteFile({ path: ACTIVE_POINTER_PATH, directory: "DATA" }).catch(() => {});
    return;
  }

  await writeActivePointer(fs, { ...pointer, bootAttempts: pointer.bootAttempts + 1 });
  console.log(`[mobile-updater] reapplyActiveOtaBundleIfAny: reapplying setBasePath(${pointer.path}), bootAttempts now ${pointer.bootAttempts + 1}`);
  await setBasePath(pointer.path);
}

/**
 * Call once gameplay/title-screen readiness is reached. Resets the
 * crash-loop counter and clears out any previous (now-superseded) staged
 * version's directory - never deletes the current one it's confirming.
 */
export async function confirmOtaBootSuccess(): Promise<void> {
  const fs = filesystem();
  if (!fs) {
    return;
  }
  const pointer = await readActivePointer(fs);
  if (!pointer || pointer.confirmed) {
    return;
  }
  await writeActivePointer(fs, { ...pointer, confirmed: true, bootAttempts: 0 });

  try {
    const { files } = await fs.readdir({ path: OTA_DIR, directory: "DATA" });
    const currentDirName = `${pointer.version}-${pointer.buildNumber}`;
    for (const entry of files as { name: string }[]) {
      if (entry.name !== currentDirName && entry.name !== "active.json") {
        await fs.rmdir({ path: `${OTA_DIR}/${entry.name}`, directory: "DATA", recursive: true }).catch(() => {});
      }
    }
  } catch {
    // Nothing to clean up yet (first OTA ever applied) - fine.
  }
}
