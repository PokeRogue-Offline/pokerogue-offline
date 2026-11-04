/**
 * DEBUG BRANCH (debug/ota-lpm-tracing) - NOT for release.
 *
 * This is the single-bundle OTA updater exactly as shipped in build 357
 * (matches upstream commit 6e48b62, one commit before the "Slim OTA"
 * channel-split rewrite), with one addition: diagLog() calls at every
 * branch/condition/catch so a production install (no Web Inspector
 * available) can be traced after the fact via Documents/ota-debug.log,
 * readable through the Files app (UIFileSharingEnabled is already on - see
 * scripts/configure-ios-infoplist.sh).
 *
 * Goal: catch the exact sequence of decisions that leads to the OTA content
 * directory vanishing while active.json survives, under Low Power Mode +
 * cold-launch, which is reproducible in under a minute per the real-device
 * testing that led to this branch. Every diagLog() call is awaited (not
 * fire-and-forget) so the log's ordering is trustworthy even across a race -
 * this trades a little speed for being able to trust "this happened before
 * that" when reading the log back.
 *
 * Original module doc comment (6e48b62), preserved below for context:
 *
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

const INSTALLED_NATIVE_FINGERPRINT = "NATIVE_FINGERPRINT_PLACEHOLDER";

const IOS_OTA_CONFIRMED = true;

// ── Diagnostic logging (debug branch only) ──────────────────────────────
//
// Every call site below is tagged uniquely and awaited, so reading
// Documents/ota-debug.log back gives a faithful, ordered trace of exactly
// which branch ran, in which JS session (DIAG_SESSION_ID distinguishes two
// overlapping process lifetimes writing to the same file), even across a
// reload/relaunch boundary. Never throws - a logging failure must never
// break the actual OTA flow, so every failure path here just console.error's
// and moves on.

const DIAG_LOG_PATH = "ota-debug.log";
const DIAG_SESSION_ID = Math.random().toString(36).slice(2, 8);
let diagSeq = 0;

function diagFilesystem(): any {
  return (typeof window !== "undefined" ? (window as any).Capacitor : undefined)?.Plugins?.Filesystem;
}

function diagStringify(data: unknown): string {
  if (data === undefined) {
    return "";
  }
  if (typeof data === "string") {
    return data;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export async function diagLog(tag: string, data?: unknown): Promise<void> {
  const seq = ++diagSeq;
  const extra = diagStringify(data);
  const line = `[${new Date().toISOString()}] [sess=${DIAG_SESSION_ID}] [#${seq}] [${tag}]${extra ? " " + extra : ""}`;
  console.log(`[mobile-updater]${line}`);

  const fs = diagFilesystem();
  if (!fs) {
    console.error(`[mobile-updater] diagLog: no Filesystem plugin, could not persist line: ${line}`);
    return;
  }

  try {
    await fs.appendFile({ path: DIAG_LOG_PATH, data: line + "\n", directory: "DATA", encoding: "utf8" });
    return;
  } catch (appendErr) {
    // appendFile unsupported on this Filesystem plugin version - fall back
    // to read-modify-write. Logged so a silent appendFile failure (vs.
    // "file didn't exist yet", which readFile below handles) isn't mistaken
    // for a clean append.
    console.warn(`[mobile-updater] diagLog: appendFile failed, falling back to read+write:`, appendErr);
  }

  try {
    let existing = "";
    try {
      const { data: d } = await fs.readFile({ path: DIAG_LOG_PATH, directory: "DATA", encoding: "utf8" });
      existing = d as string;
    } catch {
      // File doesn't exist yet on this install - starting fresh is correct.
    }
    await fs.writeFile({ path: DIAG_LOG_PATH, data: existing + line + "\n", directory: "DATA", encoding: "utf8", recursive: true });
  } catch (writeErr) {
    console.error(`[mobile-updater] diagLog: read+write fallback also failed, line lost: ${line}`, writeErr);
  }
}

// Earliest possible marker - fires the instant this module is evaluated,
// before any other code in this file runs. If two process lifetimes overlap
// (as observed on-device), both sessions' MODULE-LOAD lines will be in the
// log with different sess= ids, in true arrival order.
void diagLog("MODULE-LOAD", { href: typeof location !== "undefined" ? location.href : null });

function getInstalledNativeFingerprint(): string | null {
  const valid = /^[0-9a-f]{64}$/.test(INSTALLED_NATIVE_FINGERPRINT);
  void diagLog(valid ? "FINGERPRINT-valid" : "FINGERPRINT-invalid-or-unsubstituted-placeholder");
  return valid ? INSTALLED_NATIVE_FINGERPRINT : null;
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

function otaUnzip(): any {
  return cap()?.Plugins?.OtaUnzip;
}

function capacitorHttp(): any {
  return cap()?.Plugins?.CapacitorHttp;
}

function fileTransfer(): any {
  return cap()?.Plugins?.FileTransfer;
}

function webViewPlugin(): any {
  return cap()?.Plugins?.WebView;
}

async function setBasePath(path: string): Promise<void> {
  const plugin = webViewPlugin();
  const nativePath = path.replace(/^file:\/\//, "");
  await diagLog("SETBASEPATH-called", { path, nativePath, pluginFound: !!plugin });

  if (!plugin) {
    await diagLog("SETBASEPATH-no-plugin-noop");
    return;
  }

  try {
    await plugin.setServerBasePath({ path: nativePath });
    await diagLog("SETBASEPATH-resolved-ok", { nativePath });
  } catch (err) {
    await diagLog("SETBASEPATH-threw", { nativePath, err: String(err) });
    throw err;
  }
}

export type MobileUpdateKind = "ota" | "native-android" | "native-ios-notify-only";

export interface MobileUpdateCheckResult {
  version: string;
  buildNumber: number;
  kind: MobileUpdateKind;
  otaAsset?: GhAsset;
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
      await diagLog("FETCH-RELEASES-page-not-ok", { url, status: response.status });
      break;
    }
    const page = (await response.json()) as GhRelease[];
    releases.push(...page);
    url = parseNextLink(response.headers.get("Link"));
  }
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

async function fetchJson<T>(url: string): Promise<T> {
  const http = capacitorHttp();
  if (!http) {
    await diagLog("FETCHJSON-no-capacitorhttp-plugin");
    throw new Error("CapacitorHttp plugin not available.");
  }
  const response = await http.request({ url, method: "GET", responseType: "json" });
  if (response.status < 200 || response.status >= 300) {
    await diagLog("FETCHJSON-bad-status", { url, status: response.status });
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.data as T;
}

export async function checkForMobileUpdate(installedVersion: string, installedBuildNumber: number): Promise<MobileUpdateCheckResult | null> {
  await diagLog("CFU-called", { installedVersion, installedBuildNumber });
  const plat = platform();
  await diagLog("CFU-platform", { plat });
  if (!plat) {
    await diagLog("CFU-no-platform-return-null");
    return null;
  }

  try {
    const releases = await fetchAllReleases();
    const release = findApplicableRelease(releases, installedVersion, installedBuildNumber);
    if (!release) {
      await diagLog("CFU-no-applicable-release-return-null");
      return null;
    }
    await diagLog("CFU-applicable-release", { version: release.version, buildNumber: release.buildNumber, assetNames: release.assets.map(a => a.name) });

    const manifestAssetName = `PokeRogueOffline-${plat === "android" ? "Android" : "iOS"}-ota-manifest.json`;
    const manifestAsset = findAsset(release.assets, manifestAssetName);
    await diagLog("CFU-manifest-asset-lookup", { manifestAssetName, found: !!manifestAsset });

    const installedFingerprint = getInstalledNativeFingerprint();
    await diagLog("CFU-installed-fingerprint", { installedFingerprint });

    let manifest: OtaManifest | null = null;
    if (manifestAsset && installedFingerprint !== null) {
      await diagLog("CFU-fetching-manifest", { url: manifestAsset.browser_download_url });
      manifest = await fetchJson<OtaManifest>(manifestAsset.browser_download_url);
      await diagLog("CFU-manifest-fetched", manifest);
    } else {
      await diagLog("CFU-not-fetching-manifest", { manifestAssetPresent: !!manifestAsset, installedFingerprintNonNull: installedFingerprint !== null });
    }

    const expectedChannel = isScoomDev ? "dev" : "stable";
    const manifestUsable = manifest !== null && manifest.channel === expectedChannel;
    await diagLog("CFU-manifest-usable", { manifestUsable, manifestChannel: manifest?.channel, expectedChannel });

    const otaMatches = manifestUsable && installedFingerprint !== null && manifest!.nativeFingerprint === installedFingerprint;
    await diagLog("CFU-ota-matches", { otaMatches, manifestFingerprint: manifest?.nativeFingerprint, installedFingerprint });

    if (otaMatches) {
      const otaAssetName = `PokeRogueOffline-${plat === "android" ? "Android" : "iOS"}-ota.zip`;
      const otaAsset = findAsset(release.assets, otaAssetName);
      await diagLog("CFU-ota-asset-lookup", { otaAssetName, found: !!otaAsset });
      if (!otaAsset) {
        await diagLog("CFU-ota-asset-missing-return-null");
        return null;
      }
      if (plat === "ios" && !IOS_OTA_CONFIRMED) {
        await diagLog("CFU-ios-not-confirmed-fallback-notify-only");
        return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" };
      }
      await diagLog("CFU-return-kind-ota");
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
        await diagLog("CFU-android-apk-missing-notify-only");
        return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" };
      }
      await diagLog("CFU-return-kind-native-android");
      return { version: release.version, buildNumber: release.buildNumber, kind: "native-android", apkAsset };
    }

    await diagLog("CFU-fallthrough-notify-only");
    return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" };
  } catch (err) {
    await diagLog("CFU-threw-return-null", { err: String(err) });
    return null;
  }
}

// ── Download + verify ───────────────────────────────────────────────────

let activeDownloadController: AbortController | null = null;
let stagedOtaPath: string | null = null;
let stagedOtaResult: MobileUpdateCheckResult | null = null;
let stagedApkPath: string | null = null;

async function downloadToFile(
  url: string,
  relPath: string,
  onProgress: (p: { received: number; total: number }) => void,
  signal: AbortSignal,
): Promise<string> {
  const ft = fileTransfer();
  const fs = filesystem();
  await diagLog("DOWNLOADTOFILE-called", { url, relPath, ftFound: !!ft, fsFound: !!fs });
  if (!ft || !fs) {
    await diagLog("DOWNLOADTOFILE-missing-plugin-throw");
    throw new Error("Capacitor FileTransfer/Filesystem plugin not available.");
  }

  const { uri } = await fs.getUri({ path: relPath, directory: "CACHE" });
  await diagLog("DOWNLOADTOFILE-resolved-uri", { uri });

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
      await diagLog("DOWNLOADTOFILE-already-aborted-throw");
      throw new DOMException("Aborted", "AbortError");
    }
    await Promise.race([ft.downloadFile({ url, path: uri, progress: true }), abortPromise]);
    await diagLog("DOWNLOADTOFILE-complete", { uri });
  } catch (err) {
    await diagLog("DOWNLOADTOFILE-threw", { err: String(err) });
    throw err;
  } finally {
    listenerHandle.remove();
  }

  return uri;
}

export async function downloadMobileUpdate(result: MobileUpdateCheckResult, onProgress: (p: { received: number; total: number }) => void, signal: AbortSignal): Promise<void> {
  await diagLog("DOWNLOAD-called", { kind: result.kind, version: result.version, buildNumber: result.buildNumber });
  if (result.kind === "native-ios-notify-only") {
    await diagLog("DOWNLOAD-notify-only-throw");
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
      await diagLog("DOWNLOAD-ota-staged", { path });
      stagedOtaPath = path;
      stagedOtaResult = result;
      return;
    }

    await diagLog("DOWNLOAD-native-android-branch");
    stagedApkPath = await downloadToFile(
      result.apkAsset!.browser_download_url,
      `update-${result.version}-${result.buildNumber}.apk`,
      onProgress,
      controller.signal,
    );
    await diagLog("DOWNLOAD-apk-staged", { stagedApkPath });
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
    const parsed = JSON.parse(data as string);
    await diagLog("READPOINTER-ok", parsed);
    return parsed;
  } catch (err) {
    await diagLog("READPOINTER-missing-or-unparseable", { err: String(err) });
    return null;
  }
}

async function writeActivePointer(fs: any, pointer: ActivePointer): Promise<void> {
  await diagLog("WRITEPOINTER-before", pointer);
  await fs.writeFile({ path: ACTIVE_POINTER_PATH, data: JSON.stringify(pointer), directory: "DATA", encoding: "utf8", recursive: true });
  await diagLog("WRITEPOINTER-after", pointer);
}

async function stageAndActivateOta(): Promise<void> {
  await diagLog("STAGE-called", { stagedOtaPath, stagedOtaResult });
  if (!stagedOtaPath || !stagedOtaResult) {
    await diagLog("STAGE-no-staged-bundle-throw");
    throw new Error("No downloaded OTA bundle staged to apply.");
  }
  const fs = filesystem();
  if (!fs) {
    await diagLog("STAGE-no-filesystem-plugin-throw");
    throw new Error("Capacitor Filesystem plugin not available.");
  }
  const unzipPlugin = otaUnzip();
  if (!unzipPlugin) {
    await diagLog("STAGE-no-unzip-plugin-throw");
    throw new Error("OtaUnzip plugin not available.");
  }

  const versionDir = `${OTA_DIR}/${stagedOtaResult.version}-${stagedOtaResult.buildNumber}`;
  const { uri } = await fs.getUri({ path: versionDir, directory: "DATA" });
  await diagLog("STAGE-resolved-versiondir", { versionDir, uri });

  try {
    await diagLog("STAGE-unzip-calling", { sourcePath: stagedOtaPath, destDir: uri });
    const { entryCount } = await unzipPlugin.unzip({ sourcePath: stagedOtaPath, destDir: uri });
    await diagLog("STAGE-unzip-succeeded", { entryCount, uri });
  } catch (err) {
    await diagLog("STAGE-unzip-threw-abandoning", { versionDir, err: String(err) });
    await diagLog("STAGE-unzip-catch-rmdir-before", { versionDir });
    await fs.rmdir({ path: versionDir, directory: "DATA", recursive: true }).catch(async (rmErr: unknown) => {
      await diagLog("STAGE-unzip-catch-rmdir-itself-failed", { versionDir, rmErr: String(rmErr) });
    });
    await diagLog("STAGE-unzip-catch-rmdir-after-rethrowing", { versionDir });
    throw err;
  }

  await writeActivePointer(fs, {
    version: stagedOtaResult.version,
    buildNumber: stagedOtaResult.buildNumber,
    path: uri,
    bootAttempts: 0,
    confirmed: false,
  });
  await diagLog("STAGE-pointer-written-point-of-no-return-passed");

  await setBasePath(uri);
  await diagLog("STAGE-complete");
}

export async function applyMobileUpdateAndRelaunch(result: MobileUpdateCheckResult): Promise<void> {
  await diagLog("APPLY-called", { kind: result.kind, version: result.version, buildNumber: result.buildNumber });
  if (result.kind === "ota") {
    await diagLog("APPLY-ota-branch-before-stage");
    await stageAndActivateOta();
    await diagLog("APPLY-ota-branch-staged-activated-about-to-reload");
    window.location.reload();
    return;
  }

  if (result.kind === "native-android") {
    await diagLog("APPLY-native-android-branch", { stagedApkPath });
    if (!stagedApkPath) {
      await diagLog("APPLY-native-android-no-staged-apk-throw");
      throw new Error("No verified update staged to apply.");
    }
    const bridge = otaBridge();
    if (!bridge) {
      await diagLog("APPLY-native-android-no-bridge-throw");
      throw new Error("OtaBridge plugin not available.");
    }
    await diagLog("APPLY-native-android-installApk-before");
    await bridge.installApk({ path: stagedApkPath });
    await diagLog("APPLY-native-android-installApk-after-handed-off");
    return;
  }

  await diagLog("APPLY-no-mechanism-throw", { kind: result.kind });
  throw new Error("No in-app update mechanism for this platform/release.");
}

const OTA_REAPPLIED_SESSION_KEY = "mobile-updater:reapplied-path";

export async function reapplyActiveOtaBundleIfAny(): Promise<void> {
  await diagLog("REAPPLY-called");
  const fs = filesystem();
  if (!fs) {
    await diagLog("REAPPLY-no-filesystem-plugin-bail");
    return;
  }
  const pointer = await readActivePointer(fs);
  if (!pointer) {
    await diagLog("REAPPLY-no-pointer-bail");
    return;
  }

  let sessionGuardHit = false;
  let sessionGuardAvailable = true;
  try {
    const existing = sessionStorage.getItem(OTA_REAPPLIED_SESSION_KEY);
    sessionGuardHit = existing === pointer.path;
    await diagLog("REAPPLY-sessionguard-checked", { existing, pointerPath: pointer.path, hit: sessionGuardHit });
    if (sessionGuardHit) {
      await diagLog("REAPPLY-sessionguard-hit-skip");
      return;
    }
  } catch (err) {
    sessionGuardAvailable = false;
    await diagLog("REAPPLY-sessionguard-unavailable-fallthrough", { err: String(err) });
  }

  const wouldRollback = !pointer.confirmed && pointer.bootAttempts >= BOOT_ATTEMPT_THRESHOLD;
  await diagLog("REAPPLY-rollback-condition-evaluated", {
    confirmed: pointer.confirmed,
    bootAttempts: pointer.bootAttempts,
    threshold: BOOT_ATTEMPT_THRESHOLD,
    wouldRollback,
  });

  if (wouldRollback) {
    const versionDir = `${OTA_DIR}/${pointer.version}-${pointer.buildNumber}`;
    await diagLog("REAPPLY-rollback-branch-entered", { versionDir, bootAttempts: pointer.bootAttempts });
    await diagLog("REAPPLY-rollback-rmdir-before", { versionDir });
    await fs.rmdir({ path: versionDir, directory: "DATA", recursive: true }).catch(async (err: unknown) => {
      await diagLog("REAPPLY-rollback-rmdir-itself-failed", { versionDir, err: String(err) });
    });
    await diagLog("REAPPLY-rollback-rmdir-after");
    await diagLog("REAPPLY-rollback-deletepointer-before");
    await fs.deleteFile({ path: ACTIVE_POINTER_PATH, directory: "DATA" }).catch(async (err: unknown) => {
      await diagLog("REAPPLY-rollback-deletepointer-itself-failed", { err: String(err) });
    });
    await diagLog("REAPPLY-rollback-deletepointer-after-returning");
    return;
  }

  await diagLog("REAPPLY-no-rollback-branch-entered-incrementing");
  await writeActivePointer(fs, { ...pointer, bootAttempts: pointer.bootAttempts + 1 });

  if (sessionGuardAvailable) {
    try {
      sessionStorage.setItem(OTA_REAPPLIED_SESSION_KEY, pointer.path);
      await diagLog("REAPPLY-sessionguard-set-ok", { pointerPath: pointer.path });
    } catch (err) {
      await diagLog("REAPPLY-sessionguard-set-failed", { err: String(err) });
    }
  } else {
    await diagLog("REAPPLY-sessionguard-set-skipped-already-unavailable");
  }

  await diagLog("REAPPLY-calling-setbasepath", { pointerPath: pointer.path, newBootAttempts: pointer.bootAttempts + 1 });
  await setBasePath(pointer.path);
  await diagLog("REAPPLY-complete");
}

export async function confirmOtaBootSuccess(): Promise<void> {
  await diagLog("CONFIRM-called");
  const fs = filesystem();
  if (!fs) {
    await diagLog("CONFIRM-no-filesystem-plugin-bail");
    return;
  }
  const pointer = await readActivePointer(fs);
  if (!pointer) {
    await diagLog("CONFIRM-no-pointer-bail");
    return;
  }
  if (pointer.confirmed) {
    await diagLog("CONFIRM-already-confirmed-bail", { version: pointer.version, buildNumber: pointer.buildNumber, bootAttempts: pointer.bootAttempts });
    return;
  }

  await diagLog("CONFIRM-proceeding-to-confirm", { version: pointer.version, buildNumber: pointer.buildNumber, bootAttemptsBefore: pointer.bootAttempts });
  await writeActivePointer(fs, { ...pointer, confirmed: true, bootAttempts: 0 });
  await diagLog("CONFIRM-pointer-confirmed-written");

  const currentDirName = `${pointer.version}-${pointer.buildNumber}`;
  try {
    const { files } = await fs.readdir({ path: OTA_DIR, directory: "DATA" });
    await diagLog("CONFIRM-cleanup-readdir-ok", { currentDirName, entries: (files as { name: string }[]).map(e => e.name) });
    for (const entry of files as { name: string }[]) {
      if (entry.name !== currentDirName && entry.name !== "active.json") {
        await diagLog("CONFIRM-cleanup-removing-stale-entry", { name: entry.name, currentDirName });
        await fs.rmdir({ path: `${OTA_DIR}/${entry.name}`, directory: "DATA", recursive: true }).catch(async (err: unknown) => {
          await diagLog("CONFIRM-cleanup-rmdir-failed", { name: entry.name, err: String(err) });
        });
        await diagLog("CONFIRM-cleanup-removed-stale-entry-done", { name: entry.name });
      } else {
        await diagLog("CONFIRM-cleanup-keeping-entry", { name: entry.name, reason: entry.name === currentDirName ? "matches-current-version" : "is-active.json" });
      }
    }
  } catch (err) {
    await diagLog("CONFIRM-cleanup-readdir-failed-nothing-to-clean", { err: String(err) });
  }
  await diagLog("CONFIRM-complete");
}
