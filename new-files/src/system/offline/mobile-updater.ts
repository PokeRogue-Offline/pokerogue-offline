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
 *     supports it. The web bundle is downloaded, verified, staged, and
 *     activated in place - see the activation/rollback section below.
 *   - "native-android" / "native-ios-notify-only": fingerprints differ - a
 *     real reinstall is needed. Android downloads the real APK and hands it
 *     to the system installer (OtaBridgePlugin.installApk - this *hands
 *     off*, it does not install anything itself). iOS has no equivalent
 *     in-app mechanism (see IOS_OTA_CONFIRMED below) - SideStore/AltStore
 *     users get native updates through the already-existing AltStore source
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

// iOS's equivalent of Android's confirmed Bridge.setServerBasePath API is
// NOT confirmed (see the "iOS feasibility spike" section of the mobile
// auto-update plan) - until someone actually proves a safe WKWebView
// content-root swap against real Capacitor 8 iOS source and flips this to
// true (filling in whatever the real API/call shape turns out to be, in
// applyOtaIOS below), iOS never attempts the OTA path at all: every iOS
// release, web-only or native-touching, falls through to notify-only.
const IOS_OTA_CONFIRMED = false;

function getInstalledNativeFingerprint(): string | null {
  if (INSTALLED_NATIVE_FINGERPRINT.includes("DEV") || INSTALLED_NATIVE_FINGERPRINT === "NATIVE_FINGERPRINT_PLACEHOLDER") {
    return null;
  }
  return INSTALLED_NATIVE_FINGERPRINT;
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

export type MobileUpdateKind = "ota" | "native-android" | "native-ios-notify-only";

export interface MobileUpdateCheckResult {
  version: string;
  buildNumber: number;
  kind: MobileUpdateKind;
  /** Only set for kind "ota" - needed by downloadMobileUpdate(). */
  otaAsset?: GhAsset;
  otaBundleSha256?: string;
  /** Only set for kind "native-android" - needed by downloadMobileUpdate(). */
  apkAsset?: GhAsset;
  apkSha256?: string;
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
  const byVersion = new Map<string, MatchedRelease>();
  for (const release of releases) {
    const match = release.tag_name?.match(pattern);
    if (!match) {
      continue;
    }
    const [, versionStr, buildStr] = match;
    const buildNumber = Number.parseInt(buildStr, 10);
    const existing = byVersion.get(versionStr);
    if (!existing || buildNumber > existing.buildNumber) {
      byVersion.set(versionStr, { version: versionStr, buildNumber, assets: release.assets || [] });
    }
  }

  const applicable = Array.from(byVersion.values())
    .filter(r => {
      const cmp = compareVersions(r.version, installedVersion);
      return cmp === 1 || (cmp === 0 && r.buildNumber > installedBuildNumber);
    })
    .sort((a, b) => compareVersions(a.version, b.version) || a.buildNumber - b.buildNumber);

  return applicable.length > 0 ? applicable[applicable.length - 1] : null;
}

function findAsset(assets: GhAsset[], name: string): GhAsset | undefined {
  return assets.find(a => a.name === name);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
    if (match) {
      map.set(match[2].trim(), match[1]);
    }
  }
  return map;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Checks for an applicable update and classifies which path applies. Returns
 * null when already up to date, the platform isn't Android/iOS, or the
 * check itself fails (offline, GitHub API unreachable) - same "fail
 * silently, try again next launch" behavior as update-check-api.ts.
 */
export async function checkForMobileUpdate(installedVersion: string, installedBuildNumber: number): Promise<MobileUpdateCheckResult | null> {
  const plat = platform();
  if (!plat) {
    return null;
  }

  try {
    const releases = await fetchAllReleases();
    const release = findApplicableRelease(releases, installedVersion, installedBuildNumber);
    if (!release) {
      return null;
    }

    const manifestAsset = findAsset(release.assets, `PokeRogueOffline-${plat === "android" ? "Android" : "iOS"}-ota-manifest.json`);
    const installedFingerprint = getInstalledNativeFingerprint();

    let manifest: OtaManifest | null = null;
    if (manifestAsset && installedFingerprint !== null) {
      manifest = await fetchJson<OtaManifest>(manifestAsset.browser_download_url);
    }

    // Dev builds only ever apply dev-channel manifests - belt-and-suspenders
    // alongside the dev-/non-dev tag pattern split above.
    const manifestUsable = manifest !== null && manifest.channel === (isScoomDev ? "dev" : "stable");

    const otaMatches = manifestUsable && installedFingerprint !== null && manifest!.nativeFingerprint === installedFingerprint;

    if (otaMatches) {
      const otaAsset = findAsset(release.assets, `PokeRogueOffline-${plat === "android" ? "Android" : "iOS"}-ota.zip`);
      if (!otaAsset) {
        return null;
      }
      if (plat === "ios" && !IOS_OTA_CONFIRMED) {
        return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" };
      }
      return {
        version: release.version,
        buildNumber: release.buildNumber,
        kind: "ota",
        otaAsset,
        otaBundleSha256: manifest!.otaBundleSha256,
      };
    }

    if (plat === "android") {
      const apkAsset = findAsset(release.assets, isScoomDev ? "PokeRogueOffline-dev.apk" : "PokeRogueOffline.apk");
      const checksumsAsset = findAsset(release.assets, "SHA256SUMS.txt");
      if (!apkAsset || !checksumsAsset) {
        return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" }; // nothing we can offer - treat as notify-only
      }
      const checksums = parseChecksums(await fetchText(checksumsAsset.browser_download_url));
      const apkSha256 = checksums.get(apkAsset.name);
      if (!apkSha256) {
        return null;
      }
      return { version: release.version, buildNumber: release.buildNumber, kind: "native-android", apkAsset, apkSha256 };
    }

    return { version: release.version, buildNumber: release.buildNumber, kind: "native-ios-notify-only" };
  } catch {
    // Offline or GitHub API unreachable - fail silently, try again next launch.
    return null;
  }
}

// ── Download + verify ───────────────────────────────────────────────────

let activeDownloadController: AbortController | null = null;
let stagedOtaBytes: ArrayBuffer | null = null;
let stagedOtaResult: MobileUpdateCheckResult | null = null;
let stagedApkPath: string | null = null;

async function downloadToArrayBuffer(url: string, onProgress: (p: { received: number; total: number }) => void, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    received += value.length;
    onProgress({ received, total });
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer.buffer;
}

/** Downloads and verifies (never activates - see applyMobileUpdateAndRelaunch) whatever checkForMobileUpdate() last found applicable. */
export async function downloadMobileUpdate(result: MobileUpdateCheckResult, onProgress: (p: { received: number; total: number }) => void, signal: AbortSignal): Promise<void> {
  if (result.kind === "native-ios-notify-only") {
    throw new Error("No downloadable update for this platform/release.");
  }

  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort());
  activeDownloadController = controller;

  try {
    if (result.kind === "ota") {
      const bytes = await downloadToArrayBuffer(result.otaAsset!.browser_download_url, onProgress, controller.signal);
      const actualSha256 = await sha256Hex(bytes);
      if (actualSha256 !== result.otaBundleSha256) {
        throw new Error("Downloaded update failed checksum verification.");
      }
      stagedOtaBytes = bytes;
      stagedOtaResult = result;
      return;
    }

    // native-android: download the real APK into app-private cache storage,
    // verified against the release's own SHA256SUMS.txt before it's handed
    // to installApk().
    const bytes = await downloadToArrayBuffer(result.apkAsset!.browser_download_url, onProgress, controller.signal);
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== result.apkSha256) {
      throw new Error("Downloaded update failed checksum verification.");
    }

    const fs = filesystem();
    if (!fs) {
      throw new Error("Capacitor Filesystem plugin not available.");
    }
    const relPath = `update-${result.version}-${result.buildNumber}.apk`;
    await fs.writeFile({ path: relPath, data: new Blob([bytes]), directory: "CACHE" });
    const { uri } = await fs.getUri({ path: relPath, directory: "CACHE" });
    stagedApkPath = uri;
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
 * Stages the verified OTA bundle (downloadMobileUpdate() must have already
 * run and succeeded) into its own versioned directory, then flips the
 * active pointer - the sole "point of no return" in this whole sequence.
 * Everything before that write is safely abandonable if interrupted: the
 * previously-active (and previously-confirmed) bundle is left untouched on
 * disk the entire time.
 */
async function stageAndActivateOta(): Promise<void> {
  if (!stagedOtaBytes || !stagedOtaResult) {
    throw new Error("No verified OTA bundle staged to apply.");
  }
  const fs = filesystem();
  if (!fs) {
    throw new Error("Capacitor Filesystem plugin not available.");
  }

  const { unzipSync } = await import("fflate");
  const entries = unzipSync(new Uint8Array(stagedOtaBytes));

  const versionDir = `${OTA_DIR}/${stagedOtaResult.version}-${stagedOtaResult.buildNumber}`;

  try {
    for (const [name, bytes] of Object.entries(entries)) {
      if (name.endsWith("/")) {
        continue;
      }
      const filePath = `${versionDir}/${name}`;
      await fs.writeFile({ path: filePath, data: new Blob([bytes as Uint8Array]), directory: "DATA", recursive: true });
    }
  } catch (err) {
    // Disk full / write failure mid-stage: abandon the partial directory,
    // never flip the pointer. The previously-active bundle keeps running.
    await fs.rmdir({ path: versionDir, directory: "DATA", recursive: true }).catch(() => {});
    throw err;
  }

  const { uri } = await fs.getUri({ path: versionDir, directory: "DATA" });

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

  const bridge = otaBridge();
  await bridge?.setBasePath({ path: uri });
}

/** OTA: stages+activates (see above) and reloads. Android native fallback: hands the downloaded APK to the system installer (does not install anything itself). iOS notify-only: always rejects. */
export async function applyMobileUpdateAndRelaunch(result: MobileUpdateCheckResult): Promise<void> {
  if (result.kind === "ota") {
    await stageAndActivateOta();
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
    return;
  }
  const pointer = await readActivePointer(fs);
  if (!pointer) {
    return;
  }

  if (!pointer.confirmed && pointer.bootAttempts >= BOOT_ATTEMPT_THRESHOLD) {
    // This version never confirmed after repeated attempts - abandon it
    // and fall through to the bundled assets (always known-good) rather
    // than retrying something that doesn't start.
    await fs.rmdir({ path: `${OTA_DIR}/${pointer.version}-${pointer.buildNumber}`, directory: "DATA", recursive: true }).catch(() => {});
    await fs.deleteFile({ path: ACTIVE_POINTER_PATH, directory: "DATA" }).catch(() => {});
    return;
  }

  await writeActivePointer(fs, { ...pointer, bootAttempts: pointer.bootAttempts + 1 });
  const bridge = otaBridge();
  await bridge?.setBasePath({ path: pointer.path });
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
