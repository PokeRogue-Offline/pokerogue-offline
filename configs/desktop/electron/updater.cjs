const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ─────────────────────────────────────────────────────────────────────────
// In-Electron self-updater. Replaces this app's own on-disk binary (exe /
// AppImage / .app bundle) directly, without going through an installer.
//
// Windows and Linux ship as a single portable file, so the "update" is a
// single rename: the OS lets a running executable be renamed/deleted out
// from under itself (Windows opens executable images with FILE_SHARE_DELETE;
// POSIX lets an open file's directory entry be replaced freely), so the new
// file just gets moved into the same path the old one is still running from.
//
// macOS ships a `.app` bundle - a directory tree, not a single file - so
// there's no avoiding one extraction step: the downloaded tar.gz (a separate
// release asset from the distribution .dmg, built purely for this updater)
// is extracted into a staging directory, then the whole bundle directory is
// swapped in with one atomic rename, exactly like the single-file platforms.
//
// Nothing here is code-signed (see configs/desktop/electron/electron-builder.
// *.json - CSC_IDENTITY_AUTO_DISCOVERY: false / identity: null), so only a
// SHA-256 checksum (from the release's own published SHA256SUMS.txt) is
// verified before anything is swapped in - not a substitute for a signature,
// just a corruption/tamper-in-transit check.
// ─────────────────────────────────────────────────────────────────────────

const OWNER = 'PokeRogue-Offline';
const REPO = 'pokerogue-offline';

// Same tag shape used by update-check-api.ts / create-release.yaml:
// "v{app version}-{CI build number}".
const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:\.\d+)?)-(\d+)$/;

// Dev releases are tagged "dev-v{version}-{build}" instead - see
// mobile-updater.ts's "Dev release channel" doc comment. This file is a
// main-process CJS file, so it can't import #system/offline/scooom-dev.ts
// (an ESM renderer-side module) the way update-check-api.ts/mobile-updater.ts
// do - isDevBuild() below derives the same signal from the " DEV" suffix
// inject-build-number-banner already appends to OFFLINE_BUILD_NUMBER for
// dev builds.
const DEV_TAG_PATTERN = /^dev-v(\d+\.\d+\.\d+(?:\.\d+)?)-(\d+)$/;

// Duplicated from (not imported from) update-check-api.ts's own duplicate of
// version-converter.ts's private extractVersion/compareVersions - that file
// is a renderer-side ES module and this one is a main-process CJS file, so
// there's no clean way to share it; keep both copies in sync if this logic
// ever changes.
function extractVersion(versionString) {
  const regex = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
  if (!regex.test(versionString)) {
    throw new Error(`Invalid version string (${versionString}) in updater!`);
  }
  const versionArray = versionString.split('.').map(v => Number.parseInt(v, 10));
  if (versionArray.length === 3) {
    versionArray.push(0);
  }
  return versionArray;
}

function compareVersions(versionA, versionB) {
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

// Reuses the exact same placeholder/injection mechanism as title-ui-handler.ts's
// OFFLINE_BUILD_NUMBER (.github/actions/inject-build-number-banner, invoked a
// second time against this file by the 3 desktop build workflows, after this
// file is copied into pokerogue-src). Left unsubstituted (genuinely unbuilt/
// local runs), parseInt below yields NaN, so getInstalledBuildNumber()
// returns null and update checks are skipped entirely. CI dev builds DO get
// a real (parseable) build number, just with " DEV" appended - isDevBuild()
// below reads that same suffix to pick the dev-aware tag pattern/prerelease
// filter, instead of skipping the check entirely like this used to.
const OFFLINE_BUILD_NUMBER = 'BUILD_NUMBER_PLACEHOLDER';

function isDevBuild() {
  return OFFLINE_BUILD_NUMBER.includes('DEV');
}

function getInstalledBuildNumber() {
  const parsed = Number.parseInt(OFFLINE_BUILD_NUMBER, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// get-electron-package-version/--config.extraMetadata.version mangles
// package.json's own "X.Y.Z.W" version into a plain-numeric "X.Y.ZW" for
// electron-builder, and that mangled string is what ends up in the
// package.json electron-builder ships at the app root - so reading it at
// runtime (as this used to) silently desyncs from the dotted version in the
// release tags and makes findApplicableUpdate() miss every update. The real
// version is instead baked in at build time (inject-app-version, run before
// get-electron-package-version touches package.json), the same way
// OFFLINE_BUILD_NUMBER is above.
const OFFLINE_APP_VERSION = 'APP_VERSION_PLACEHOLDER';

function getInstalledVersion() {
  return OFFLINE_APP_VERSION;
}

function releasesUrl() {
  // Overridable for local testing against a fake "newer release" server,
  // without needing a real tagged GitHub release - see the plan's
  // verification section. Defaults to the real GitHub API.
  const base = process.env.POKEROGUE_UPDATE_API_BASE || 'https://api.github.com';
  return `${base}/repos/${OWNER}/${REPO}/releases?per_page=100`;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

async function fetchAllReleases() {
  const releases = [];
  let url = releasesUrl();
  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      break;
    }
    const page = await response.json();
    releases.push(...page);
    url = parseNextLink(response.headers.get('Link'));
  }
  // A release is published prerelease:true and manually flipped off once
  // ready to go live - mirrors update-check-api.ts's own filter. Dev
  // releases are always prerelease (never promoted) - dev builds must not
  // filter them out.
  return releases.filter(r => !r.draft && (isDevBuild() || !r.prerelease));
}

/**
 * Collapses releases down to one entry per app version (highest build
 * number wins), then returns the single newest release strictly ahead of
 * what's installed, or null. Mirrors update-check-api.ts's checkForUpdates()
 * logic, but keeps `assets` (needed to actually download something) instead
 * of a changelog (the renderer-side screen already has that).
 */
function findApplicableUpdate(releases, installedVersion, installedBuildNumber) {
  const pattern = isDevBuild() ? DEV_TAG_PATTERN : TAG_PATTERN;
  const byVersion = new Map();
  for (const release of releases) {
    const match = release.tag_name?.match(pattern);
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
        assets: release.assets || [],
      });
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

function pickAssetName() {
  // Dev releases ship every asset under a "-dev" suffix (see
  // create-release.yaml's "Set naming suffix" step) so they never collide
  // with real releases on an automatic check (e.g. AltStore's).
  const tag = isDevBuild() ? '-dev' : '';
  if (process.platform === 'win32') {
    return `PokeRogueOffline${tag}.exe`;
  }
  if (process.platform === 'linux') {
    return `PokeRogueOffline${tag}.AppImage`;
  }
  if (process.platform === 'darwin') {
    return `PokeRogueOffline${tag}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.app.tar.gz`;
  }
  return null;
}

function getMacAppBundlePath() {
  let dir = path.dirname(process.execPath); // .../Some.app/Contents/MacOS
  while (dir !== path.dirname(dir)) {
    if (dir.endsWith('.app')) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate the running .app bundle path.');
}

function getInstallDir() {
  if (process.platform === 'darwin') {
    return path.dirname(getMacAppBundlePath());
  }
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    return path.dirname(process.env.APPIMAGE);
  }
  return path.dirname(process.execPath);
}

function getStagingDir() {
  // Same volume as the install dir, required for the rename-based swaps
  // below to be atomic (a cross-device rename isn't).
  return path.join(getInstallDir(), '.pokerogue-update-staging');
}

async function downloadToFile(url, destPath, onProgress, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;

  const fileStream = fs.createWriteStream(destPath);
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      fileStream.write(chunk);
      onProgress?.(received, total);
    }
  } finally {
    await new Promise(resolve => fileStream.end(resolve));
  }
}

function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
    if (match) {
      map.set(match[2].trim(), match[1]);
    }
  }
  return map;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function extractTarGz(archivePath, destDir) {
  // Both macOS and Linux ship `tar` out of the box; this only runs on
  // darwin, but using the system binary avoids adding a tar-parsing
  // dependency just for this one platform's one-time extraction step.
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', archivePath, '-C', destDir], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`tar extraction failed: ${stderr || err.message}`));
      } else {
        resolve();
      }
    });
  });
}

function pendingSwapFlagPath() {
  return path.join(app.getPath('userData'), 'pending-update-swap.json');
}

function writePendingSwapFlag(oldPath) {
  fs.writeFileSync(pendingSwapFlagPath(), JSON.stringify({ oldPath }), 'utf8');
}

/**
 * Runs once at startup. Reaching this point means the app launched
 * successfully post-swap (main.cjs got as far as calling registerUpdater()),
 * so it's safe to drop whatever the previous swap renamed aside. If nothing
 * was pending, this is a no-op.
 */
function cleanupStaleSwap() {
  const flagPath = pendingSwapFlagPath();
  if (!fs.existsSync(flagPath)) {
    return;
  }
  try {
    const { oldPath } = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
    if (oldPath && fs.existsSync(oldPath)) {
      fs.rmSync(oldPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('Failed to clean up previous update swap:', err);
  } finally {
    fs.rmSync(flagPath, { force: true });
  }
  fs.rmSync(getStagingDir(), { recursive: true, force: true });
}

/** Swaps the staged download into place and returns the path to relaunch. */
async function applyUpdate(stagedPath) {
  if (process.platform === 'win32') {
    const target = process.execPath;
    const oldPath = `${target}.old`;
    fs.rmSync(oldPath, { force: true });
    fs.renameSync(target, oldPath);
    fs.renameSync(stagedPath, target);
    writePendingSwapFlag(oldPath);
    return target;
  }

  if (process.platform === 'linux') {
    const target = process.env.APPIMAGE;
    if (!target) {
      throw new Error('APPIMAGE environment variable not set - not running as an AppImage, cannot self-update.');
    }
    const oldPath = `${target}.old`;
    fs.rmSync(oldPath, { force: true });
    fs.renameSync(target, oldPath);
    fs.renameSync(stagedPath, target);
    writePendingSwapFlag(oldPath);
    return target;
  }

  if (process.platform === 'darwin') {
    const bundlePath = getMacAppBundlePath();
    const extractDir = path.join(getStagingDir(), 'extracted');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarGz(stagedPath, extractDir);

    const extractedName = fs.readdirSync(extractDir).find(name => name.endsWith('.app'));
    if (!extractedName) {
      throw new Error('Downloaded update archive did not contain a .app bundle.');
    }
    const newBundlePath = path.join(extractDir, extractedName);

    const oldPath = `${bundlePath}.old`;
    fs.rmSync(oldPath, { recursive: true, force: true });
    fs.renameSync(bundlePath, oldPath);
    fs.renameSync(newBundlePath, bundlePath);
    writePendingSwapFlag(oldPath);

    return path.join(bundlePath, 'Contents', 'MacOS', path.basename(process.execPath));
  }

  throw new Error(`Self-update is not supported on platform "${process.platform}".`);
}

function relaunchAndExit(execPath) {
  app.relaunch({ execPath });
  app.exit(0);
}

let registered = false;

function registerUpdater(mainWindow) {
  // createWindow() (and so registerUpdater()) can run again on macOS via the
  // 'activate' handler once all windows have closed - guard against
  // registering the same ipcMain.handle channels twice, which electron
  // throws on.
  if (registered) {
    return;
  }
  registered = true;

  cleanupStaleSwap();

  let activeDownloadController = null;
  let verifiedStagedPath = null;

  ipcMain.handle('updater-check', async () => {
    const installedBuildNumber = getInstalledBuildNumber();
    if (installedBuildNumber === null) {
      return null;
    }
    try {
      const releases = await fetchAllReleases();
      const update = findApplicableUpdate(releases, getInstalledVersion(), installedBuildNumber);
      return update ? { version: update.version, buildNumber: update.buildNumber, tagName: update.tagName } : null;
    } catch (err) {
      console.warn('Update check failed:', err);
      return null;
    }
  });

  ipcMain.handle('updater-download', async () => {
    const installedBuildNumber = getInstalledBuildNumber();
    if (installedBuildNumber === null) {
      throw new Error('Update checks are disabled on this build.');
    }

    const assetName = pickAssetName();
    if (!assetName) {
      throw new Error(`Self-update is not supported on platform "${process.platform}".`);
    }

    const releases = await fetchAllReleases();
    const update = findApplicableUpdate(releases, getInstalledVersion(), installedBuildNumber);
    if (!update) {
      throw new Error('No update available.');
    }

    const asset = update.assets.find(a => a.name === assetName);
    const checksumsAsset = update.assets.find(a => a.name === 'SHA256SUMS.txt');
    if (!asset || !checksumsAsset) {
      throw new Error('This release is missing the files this updater needs for your platform.');
    }

    const stagingDir = getStagingDir();
    fs.mkdirSync(stagingDir, { recursive: true });
    const stagedPath = path.join(stagingDir, assetName);

    const controller = new AbortController();
    activeDownloadController = controller;
    verifiedStagedPath = null;

    try {
      await downloadToFile(
        asset.browser_download_url,
        stagedPath,
        (received, total) => mainWindow.webContents.send('updater-download-progress', { received, total }),
        controller.signal,
      );

      const checksumsResponse = await fetch(checksumsAsset.browser_download_url, { signal: controller.signal });
      const checksums = parseChecksums(await checksumsResponse.text());
      const expectedHash = checksums.get(assetName);
      if (!expectedHash) {
        throw new Error(`No checksum published for ${assetName}.`);
      }
      if ((await sha256File(stagedPath)) !== expectedHash) {
        throw new Error('Downloaded update failed checksum verification.');
      }

      verifiedStagedPath = stagedPath;
      return { version: update.version, buildNumber: update.buildNumber };
    } catch (err) {
      fs.rmSync(stagedPath, { force: true });
      throw err;
    } finally {
      activeDownloadController = null;
    }
  });

  ipcMain.on('updater-cancel-download', () => {
    activeDownloadController?.abort();
  });

  ipcMain.handle('updater-apply-and-relaunch', async () => {
    if (!verifiedStagedPath || !fs.existsSync(verifiedStagedPath)) {
      throw new Error('No verified update staged to apply.');
    }
    const execPath = await applyUpdate(verifiedStagedPath);
    relaunchAndExit(execPath);
  });
}

module.exports = { registerUpdater };
