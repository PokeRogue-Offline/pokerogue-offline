// ─────────────────────────────────────────────────────────────────────────
// Desktop OTA content updates.
//
// The Electron shell (main.cjs, preload.cjs, updater.cjs, this file, the
// Electron runtime itself, node_modules) is only ever replaced by the
// full-binary updater in updater.cjs. The web content (dist/) is different:
// it is the same code/assets/locales split the mobile apps update over the
// air, and this file does the same for desktop.
//
//   - Content lives in <userData>/ota-stable/ota/active (or ota-dev for dev
//     builds, which share userData with stable ones). main.cjs loads
//     index.html from there when a complete, usable set is present, and
//     from the bundled dist/ otherwise.
//   - The state machine (pointers, backups, write-ahead marker, rollback)
//     is ota-core.cjs: the SAME source the mobile apps run, transpiled from
//     new-files/src/system/offline/ota-core.ts at build time.
//
// ── Stage while running, swap at the next launch ─────────────────────────
// Windows keeps files that are in use locked, so content is never replaced
// under a running window. While the app runs, an update is downloaded,
// SHA-256 verified against the release manifest, and unzipped into a
// staging directory - nothing the window is using is touched. The swap
// into place (a handful of renames) happens at the next launch, before the
// window loads anything. There is no live hot-swap.
//
// ── First update ─────────────────────────────────────────────────────────
// The bundled dist/ sits inside the app archive and cannot be modified, so
// the first update copies it out to ota/active once. That copy is labelled
// with the channel versions of the release this shell was built from (read
// from that release's manifest), which is how a later release knows which
// channels actually changed - a code-only release then downloads a few MB
// rather than everything.
//
// ── What ties content to a shell ─────────────────────────────────────────
// Content is only offered when the release's manifest carries this shell's
// own fingerprint (scripts/compute-native-fingerprint.js desktop); any
// other release goes through the full-binary updater. Installed content is
// also discarded at launch when the shell it was installed under is not
// the one now running (the app was updated or replaced): the new shell's
// bundled content supersedes it.
//
// Nothing here requires `electron` at load time - registerDesktopOtaIpc()
// at the bottom is the only part that does - so the engine can be driven
// from plain Node.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const core = require('./ota-core.cjs');
const { downloadToFile } = require('./update-io.cjs');

const OWNER = 'PokeRogue-Offline';
const REPO = 'pokerogue-offline';

const MANIFEST_ASSET_NAME = 'PokeRogueOffline-Desktop-ota-manifest.json';
function channelAssetName(channel) {
  return `PokeRogueOffline-Desktop-ota-${channel}.zip`;
}

// Substituted at build time by .github/actions/inject-desktop-fingerprint.
// The substitution is a global replace over this file, so the placeholder
// text must appear exactly once, here. Left unsubstituted (a local, unbuilt
// run), getShellFingerprint() returns null and content updates are off.
const INSTALLED_SHELL_FINGERPRINT = 'DESKTOP_FINGERPRINT_PLACEHOLDER';

function getShellFingerprint() {
  return /^[0-9a-f]{64}$/.test(INSTALLED_SHELL_FINGERPRINT) ? INSTALLED_SHELL_FINGERPRINT : null;
}

// ── Unzip ────────────────────────────────────────────────────────────────

function stripLeadingSegment(entryName) {
  const slashIndex = entryName.indexOf('/');
  return slashIndex === -1 ? entryName : entryName.slice(slashIndex + 1);
}

/** True for a zip entry whose Unix mode says "symbolic link". */
function isSymlinkEntry(entry) {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

/**
 * Unzips `zipPath` into `destDir`, stripping the single leading path
 * segment every channel zip wraps its content in. Streams each entry to
 * disk. Returns the number of files written.
 *
 * Zip-slip guard: every entry's destination is resolved and must stay
 * inside destDir; an entry that would not, and any symlink entry, fails
 * the whole unzip. (yauzl already rejects absolute paths, "..", and
 * backslashes in entry names; this does not rely on that.)
 */
function unzipTo(zipPath, destDir, expect = {}, signal) {
  const yauzl = require('yauzl');
  const destRoot = path.resolve(destDir);

  return new Promise((resolve, reject) => {
    if (expect.bytes !== undefined) {
      let actual;
      try {
        actual = fs.statSync(zipPath).size;
      } catch (err) {
        reject(err);
        return;
      }
      if (actual !== expect.bytes) {
        reject(new Error(`Downloaded file is ${actual} bytes, expected ${expect.bytes} - the download is incomplete.`));
        return;
      }
    }

    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr) {
        reject(openErr);
        return;
      }
      let entryCount = 0;
      let settled = false;
      const fail = err => {
        if (!settled) {
          settled = true;
          zipfile.close();
          reject(err);
        }
      };

      zipfile.on('error', fail);
      zipfile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({ entryCount });
        }
      });
      zipfile.on('entry', entry => {
        if (signal?.aborted) {
          fail(new Error('Update cancelled.'));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry(); // directory entry
          return;
        }
        const relativeName = stripLeadingSegment(entry.fileName);
        if (relativeName === '') {
          zipfile.readEntry();
          return;
        }
        if (isSymlinkEntry(entry)) {
          fail(new Error(`Zip entry is a symbolic link: ${entry.fileName}`));
          return;
        }
        const outPath = path.resolve(destRoot, relativeName);
        if (!outPath.startsWith(destRoot + path.sep)) {
          fail(new Error(`Zip entry escapes destination directory: ${entry.fileName}`));
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) {
            fail(streamErr);
            return;
          }
          fsp
            .mkdir(path.dirname(outPath), { recursive: true })
            .then(() => pipeline(readStream, fs.createWriteStream(outPath)))
            .then(() => {
              entryCount++;
              zipfile.readEntry();
            }, fail);
        });
      });
      zipfile.readEntry();
    });
  });
}

// ── Filesystem adapter for ota-core ──────────────────────────────────────

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Windows fails a rename with EPERM/EBUSY/EACCES while anything else (an
 * antivirus scanner, the search indexer) briefly has the file or directory
 * open. Those clear in well under a second; anything that persists is a
 * real failure and is rethrown.
 */
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err.code) || attempt >= 5) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

/** ota-core's filesystem on top of Node's fs. Every path is confined to `root`. */
function createNodeOtaFs(root, getSignal = () => undefined) {
  const rootAbs = path.resolve(root);
  const abs = relPath => {
    const out = path.resolve(rootAbs, relPath);
    if (out !== rootAbs && !out.startsWith(rootAbs + path.sep)) {
      throw new Error(`OTA path escapes its root: ${relPath}`);
    }
    return out;
  };
  return {
    async readText(relPath) {
      try {
        return await fsp.readFile(abs(relPath), 'utf8');
      } catch {
        return null;
      }
    },
    async writeText(relPath, data) {
      const target = abs(relPath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data, 'utf8');
    },
    async exists(relPath) {
      try {
        await fsp.access(abs(relPath));
        return true;
      } catch {
        return false;
      }
    },
    async rename(from, to) {
      await renameWithRetry(abs(from), abs(to));
    },
    async rmrf(relPath) {
      await fsp.rm(abs(relPath), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
    async mkdirp(relPath) {
      await fsp.mkdir(abs(relPath), { recursive: true });
    },
    async unzip(zipPath, destDir, expect) {
      return unzipTo(zipPath, abs(destDir), expect, getSignal());
    },
  };
}

// ── Small helpers ────────────────────────────────────────────────────────

function readJsonFileSync(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function positiveInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isPidAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, just not ours to signal
  }
}

/** Walks `dir`, calling onFile(relativePath, size) for every file. Uses only readdir/stat, which work inside an app archive too. */
async function walkFiles(dir, onFile, relPrefix = '') {
  for (const name of await fsp.readdir(dir)) {
    const absPath = path.join(dir, name);
    const relPath = relPrefix ? `${relPrefix}/${name}` : name;
    const stat = await fsp.stat(absPath);
    if (stat.isDirectory()) {
      await walkFiles(absPath, onFile, relPath);
    } else {
      await onFile(relPath, stat.size);
    }
  }
}

/**
 * Copies a directory tree file by file with readFile/writeFile. The source
 * is the bundled dist/ inside the app archive: reading files out of it one
 * at a time is long-supported, whereas a recursive copy from an archive is
 * not something every Electron version in the field can do.
 */
async function copyTree(srcDir, destDir, onProgress, signal) {
  let copied = 0;
  await walkFiles(srcDir, async (relPath, size) => {
    if (signal?.aborted) {
      throw new Error('Update cancelled.');
    }
    const target = path.join(destDir, relPath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, await fsp.readFile(path.join(srcDir, relPath)));
    copied += size;
    onProgress?.(copied);
  });
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

// ── The engine ───────────────────────────────────────────────────────────

/**
 * options:
 *   userDataDir     Electron's userData directory.
 *   bundledDistDir  The dist/ shipped inside the app.
 *   shell           { fingerprint, version, buildNumber, dev } - the running
 *                   shell. A null fingerprint or buildNumber (unbuilt/local
 *                   run) turns content updates off entirely.
 *   apiBase         GitHub API base (overridable for local testing).
 *   log             (message) => void
 *   fetchImpl, pid, isPidAlive, freeBytes   injectable, default to the real ones.
 */
function createDesktopOta(options) {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? isPidAliveDefault;
  const apiBase = options.apiBase ?? 'https://api.github.com';
  const shell = options.shell;
  const dev = shell.dev === true;

  const enabled = typeof shell.fingerprint === 'string' && Number.isInteger(shell.buildNumber) && typeof shell.version === 'string';
  // Everything that makes this shell "this shell". Content installed under
  // a different identity is never served.
  const identity = enabled ? `${shell.fingerprint}:${shell.version}:${shell.buildNumber}:${dev ? 'dev' : 'stable'}` : null;

  const root = path.join(options.userDataDir, dev ? 'ota-dev' : 'ota-stable');
  const bundledIndex = path.join(options.bundledDistDir, 'index.html');
  const activeIndex = path.join(root, core.ACTIVE_DIR, 'index.html');
  const pendingDir = path.join(root, 'pending');
  const pendingPath = path.join(root, 'pending.json');
  const instancesDir = path.join(root, 'instances');
  const lockPath = path.join(root, 'update.lock');

  let activeSignal;
  const otaFs = createNodeOtaFs(root, () => activeSignal);

  // ── Other running copies ───────────────────────────────────────────────
  // Two copies of the app can run at once. Content is only swapped, rolled
  // back or recovered by a copy that is alone, because another copy may
  // have those very files open; any later copy just loads whatever is
  // currently in place. A short-lived lock file additionally keeps two
  // copies from running a critical section at the same moment.

  function registerInstance() {
    fs.mkdirSync(instancesDir, { recursive: true });
    fs.writeFileSync(path.join(instancesDir, String(pid)), '');
  }

  function unregisterInstance() {
    fs.rmSync(path.join(instancesDir, String(pid)), { force: true });
  }

  function otherInstancesAlive() {
    let names;
    try {
      names = fs.readdirSync(instancesDir);
    } catch {
      return false;
    }
    let alive = false;
    for (const name of names) {
      const otherPid = Number.parseInt(name, 10);
      if (otherPid === pid) {
        continue;
      }
      if (Number.isInteger(otherPid) && isPidAlive(otherPid)) {
        alive = true;
      } else {
        fs.rmSync(path.join(instancesDir, name), { force: true }); // left behind by a copy that crashed
      }
    }
    return alive;
  }

  function acquireLock() {
    fs.mkdirSync(root, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, String(pid));
        fs.closeSync(fd);
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') {
          return false;
        }
        const holder = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        if (Number.isInteger(holder) && holder !== pid && isPidAlive(holder)) {
          return false;
        }
        fs.rmSync(lockPath, { force: true }); // holder is gone - stale
      }
    }
    return false;
  }

  function releaseLock() {
    fs.rmSync(lockPath, { force: true });
  }

  // ── Launch ─────────────────────────────────────────────────────────────

  let launchResult = null;
  // True when this process did the boot bookkeeping (and so is the one
  // entitled to record "loaded" and "confirmed" for this launch).
  let ownsBoot = false;
  let loadMarked = false;
  let confirmed = false;

  /** Whether ota/active is complete and usable, decided without writing anything. For a copy that is not alone. */
  function isActiveUsableReadOnly() {
    const otaDir = path.join(root, core.OTA_DIR);
    const markerNames = ['inprogress-bootstrap.json', ...core.CHANNELS.map(c => `inprogress-${c}.json`)];
    for (const name of markerNames) {
      if (fs.existsSync(path.join(otaDir, name)) || fs.existsSync(path.join(otaDir, `${name}.new`))) {
        return false;
      }
    }
    for (const channel of core.CHANNELS) {
      const pointer = readJsonFileSync(path.join(otaDir, `active-${channel}.json`));
      if (!pointer || typeof pointer.version !== 'string') {
        return false;
      }
    }
    const shellFile = readJsonFileSync(path.join(otaDir, 'shell.json'));
    return shellFile?.identity === identity && fs.existsSync(activeIndex);
  }

  /** Swaps in whatever an earlier run staged. Idempotent: a channel that is already at the pending version is skipped. */
  async function applyPending() {
    // Downloaded zips are deleted as soon as they are unzipped, so anything
    // still here is from a download that was cut off.
    await fsp.rm(pendingDir, { recursive: true, force: true });

    const pending = readJsonFileSync(pendingPath);
    if (!pending) {
      // Staged content with no record of what it is for: a download that
      // was cut off between unzipping and recording. Never usable.
      for (const channel of core.CHANNELS) {
        await core.discardStaged(otaFs, channel);
      }
      return;
    }
    const channels = core.CHANNELS.filter(channel => typeof pending.channels?.[channel] === 'string');
    const discardPending = async reason => {
      log(`pending update discarded: ${reason}`);
      for (const channel of channels) {
        await core.discardStaged(otaFs, channel);
      }
      await fsp.rm(pendingPath, { force: true });
    };

    if (pending.identity !== identity) {
      await discardPending('it was staged under a different app build');
      return;
    }
    if (!(await core.isOtaBootstrapped(otaFs))) {
      await discardPending('the installed content it was meant to update is gone');
      return;
    }

    // All or nothing up front: the channels of one release belong together,
    // so if any of them is no longer staged (a rollback discarded it), none
    // of the rest is applied either.
    const toSwap = [];
    for (const channel of channels) {
      const version = pending.channels[channel];
      if ((await core.readChannelPointer(otaFs, channel))?.version === version) {
        continue; // already swapped by a launch that was interrupted after it
      }
      if ((await core.readStagedVersion(otaFs, channel)) !== version) {
        await discardPending(`staged ${channel} content is missing`);
        return;
      }
      toSwap.push(channel);
    }

    for (const channel of toSwap) {
      await core.swapStagedChannel(otaFs, channel, pending.channels[channel], { log });
    }
    await fsp.rm(pendingPath, { force: true });
    log(`applied staged update ${pending.version}+${pending.buildNumber} (${toSwap.join(', ') || 'nothing left to swap'})`);
  }

  /**
   * Call once at startup, BEFORE the window loads anything. Finishes or
   * undoes an interrupted swap, swaps in a staged update, rolls back
   * content that keeps failing to boot, and returns which index.html to
   * load. Never throws: any failure means "load the bundled content".
   */
  async function prepareLaunch() {
    if (launchResult) {
      return launchResult; // a second window in the same process (macOS re-activate)
    }
    launchResult = { indexPath: bundledIndex, servingOta: false };
    if (!enabled) {
      return launchResult;
    }

    try {
      registerInstance();
      let serve = false;
      if (!otherInstancesAlive() && acquireLock()) {
        try {
          await core.recoverInProgress(otaFs, log);
          await applyPending();
          serve = await core.prepareBoot(otaFs, { shellIdentity: identity, log });
          ownsBoot = serve;
        } finally {
          releaseLock();
        }
      } else {
        serve = isActiveUsableReadOnly();
        log(`another copy is running - not applying updates; serving ${serve ? 'installed' : 'bundled'} content`);
      }
      if (serve) {
        launchResult = { indexPath: activeIndex, servingOta: true };
      }
    } catch (err) {
      log(`prepareLaunch failed, using bundled content: ${err?.stack || err}`);
      ownsBoot = false;
      launchResult = { indexPath: bundledIndex, servingOta: false };
    }
    return launchResult;
  }

  /** The window finished loading the installed content: this launch got as far as running it. */
  async function noteLoadFinished() {
    if (!ownsBoot || loadMarked) {
      return;
    }
    loadMarked = true;
    try {
      await core.markLoadReached(otaFs);
    } catch (err) {
      log(`markLoadReached failed: ${err?.message || err}`);
    }
  }

  let titleReached = false;

  /** Whether the content shown in this process has reached the title screen at least once. */
  function hasReachedTitle() {
    return titleReached;
  }

  /** The title screen was reached: the installed content is good. */
  async function noteTitleScreen() {
    titleReached = true;
    if (!ownsBoot || confirmed) {
      return;
    }
    confirmed = true;
    try {
      await core.confirmBootSuccess(otaFs);
    } catch (err) {
      confirmed = false;
      log(`confirmBootSuccess failed: ${err?.message || err}`);
    }
  }

  /** The installed content failed to load; this window is falling back to the bundled content. */
  function noteLoadFailed() {
    // Nothing to write: the launch was already counted when it started and
    // will simply never be marked as loaded or confirmed. Stop this process
    // from doing either later (the bundled content will reach the title screen).
    ownsBoot = false;
  }

  function shutdown() {
    try {
      unregisterInstance();
    } catch {
      // nothing useful to do on the way out
    }
  }

  // ── Check ──────────────────────────────────────────────────────────────

  async function fetchJson(url, signal) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
  }

  /** Same policy as the mobile updater: stable asks for the one "latest" release, dev pages (dev releases are prereleases). */
  async function fetchCandidateReleases() {
    const repoUrl = `${apiBase}/repos/${OWNER}/${REPO}`;
    if (!dev) {
      try {
        const latest = await fetchJson(`${repoUrl}/releases/latest`);
        if (latest && typeof latest.tag_name === 'string' && core.TAG_PATTERN.test(latest.tag_name) && !latest.draft && !latest.prerelease) {
          return [latest];
        }
      } catch {
        // fall through to the full list
      }
    }
    const releases = [];
    let url = `${repoUrl}/releases?per_page=100`;
    while (url) {
      const response = await fetchImpl(url);
      if (!response.ok) {
        break;
      }
      releases.push(...(await response.json()));
      url = parseNextLink(response.headers.get('Link'));
    }
    return releases.filter(r => !r.draft && (dev || !r.prerelease));
  }

  /** A manifest this shell may use: right shape, right channel, built for this exact shell. */
  function isUsableManifest(manifest) {
    if (!manifest || manifest.schemaVersion !== 2 || manifest.channel !== (dev ? 'dev' : 'stable') || manifest.nativeFingerprint !== shell.fingerprint) {
      return false;
    }
    return core.CHANNELS.every(channel => typeof manifest[channel]?.version === 'string' && /^[0-9a-f]{64}$/.test(manifest[channel]?.sha256 ?? ''));
  }

  async function fetchReleaseManifest(assets, signal) {
    const asset = (assets || []).find(a => a.name === MANIFEST_ASSET_NAME);
    return asset ? fetchJson(asset.browser_download_url, signal) : null;
  }

  /** Channel versions of the content this shell shipped with: the manifest of the release it was built from. */
  async function fetchBundledVersions() {
    const tag = `${dev ? 'dev-' : ''}v${shell.version}-${shell.buildNumber}`;
    const release = await fetchJson(`${apiBase}/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
    const manifest = await fetchReleaseManifest(release.assets);
    if (!isUsableManifest(manifest) || manifest.version !== shell.version || manifest.buildNumber !== shell.buildNumber) {
      return null;
    }
    return Object.fromEntries(core.CHANNELS.map(channel => [channel, manifest[channel].version]));
  }

  let lastCheck = null;

  /**
   * Decides how the running content (`installedVersion`+`installedBuildNumber`,
   * as the renderer reports it) can get to the newest release:
   *   null                 nothing newer
   *   { kind: 'binary' }   needs the full-binary updater
   *   { kind: 'ota', version, buildNumber, files: [{ id, bytes }], staged }
   *                        content update; `staged` is true when it is
   *                        already downloaded and only waiting for a restart
   */
  async function check(installedVersion, installedBuildNumber) {
    lastCheck = null;
    if (!enabled) {
      return { kind: 'binary' };
    }
    const release = core.findApplicableRelease(await fetchCandidateReleases(), installedVersion, installedBuildNumber, dev);
    if (!release) {
      return null;
    }
    const binary = { kind: 'binary', version: release.version, buildNumber: release.buildNumber };

    let manifest;
    try {
      manifest = await fetchReleaseManifest(release.assets);
    } catch (err) {
      log(`could not read the release's content manifest: ${err?.message || err}`);
      return binary;
    }
    if (!isUsableManifest(manifest)) {
      return binary; // no manifest, another channel, or built for a different shell
    }

    const pending = readJsonFileSync(pendingPath);
    if (pending && pending.identity === identity && pending.version === release.version && pending.buildNumber === release.buildNumber) {
      return { kind: 'ota', version: release.version, buildNumber: release.buildNumber, files: [], staged: true };
    }

    const bootstrapped = await core.isOtaBootstrapped(otaFs);
    let installed;
    let bundledVersions = null;
    if (bootstrapped) {
      installed = {};
      for (const channel of core.CHANNELS) {
        installed[channel] = (await core.readChannelPointer(otaFs, channel))?.version ?? null;
      }
    } else {
      try {
        bundledVersions = await fetchBundledVersions();
      } catch (err) {
        log(`could not determine the bundled content's versions: ${err?.message || err}`);
      }
      if (!bundledVersions) {
        return binary;
      }
      installed = bundledVersions;
    }

    const channels = [];
    for (const channel of core.CHANNELS) {
      const entry = manifest[channel];
      if (installed[channel] === entry.version) {
        continue;
      }
      const asset = release.assets.find(a => a.name === channelAssetName(channel));
      if (!asset) {
        return binary;
      }
      const bytes = positiveInt(entry.bytes) ?? positiveInt(asset.size) ?? 0;
      channels.push({
        id: channel,
        url: asset.browser_download_url,
        version: entry.version,
        sha256: entry.sha256,
        bytes,
        entries: positiveInt(entry.entries),
        unpackedBytes: positiveInt(entry.unpackedBytes),
      });
    }
    if (channels.length === 0) {
      return null; // newer tag, identical content
    }

    lastCheck = { version: release.version, buildNumber: release.buildNumber, channels, bundledVersions, bootstrapped };
    return {
      kind: 'ota',
      version: release.version,
      buildNumber: release.buildNumber,
      files: channels.map(c => ({ id: c.id, bytes: c.bytes })),
      staged: false,
    };
  }

  // ── Download + stage ───────────────────────────────────────────────────

  async function freeBytes() {
    if (options.freeBytes) {
      return options.freeBytes(root);
    }
    try {
      const stat = await fsp.statfs(root);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch {
      return null; // can't tell - the check is skipped, never failed
    }
  }

  function formatMb(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  let activeController = null;

  /**
   * Downloads, verifies and stages the update the last check() found.
   * Nothing the running window uses is touched; the update takes effect at
   * the next launch.
   *
   * onProgress({ phase, id, index, received, total }):
   *   phase 'download'  bytes of file `id` received so far
   *   phase 'prepare'   bytes of the bundled content copied (first update only)
   *   phase 'unpack'    file `id` is being unzipped (no byte counts)
   */
  async function download(onProgress) {
    const plan = lastCheck;
    if (!enabled || !plan) {
      throw new Error('No content update to download - check for updates first.');
    }
    if (!acquireLock()) {
      throw new Error('Another copy of the game is installing an update.');
    }

    const controller = new AbortController();
    activeController = controller;
    activeSignal = controller.signal;
    const emit = progress => {
      try {
        onProgress?.(progress);
      } catch {
        // a progress listener must never break the update
      }
    };
    const throwIfCancelled = () => {
      if (controller.signal.aborted) {
        throw new Error('Update cancelled.');
      }
    };

    let completed = false;
    try {
      registerInstance();
      const bootstrapped = await core.isOtaBootstrapped(otaFs);
      if (!bootstrapped && !plan.bundledVersions) {
        throw new Error('This update needs to be checked for again.');
      }

      // Will it fit? Every zip, every channel unzipped, plus - the first
      // time - a copy of the bundled content.
      let seedBytes = 0;
      if (!bootstrapped) {
        await walkFiles(options.bundledDistDir, (_rel, size) => {
          seedBytes += size;
        });
      }
      if (plan.channels.every(c => c.bytes > 0)) {
        const required = core.estimateRequiredBytes(
          plan.channels.map(c => ({ bytes: c.bytes, unpackedBytes: c.unpackedBytes ?? undefined })),
          seedBytes,
        );
        const free = await freeBytes();
        if (free !== null && free < required) {
          throw new Error(`Not enough free disk space for this update: about ${formatMb(required)} needed, ${formatMb(free)} available.`);
        }
      }

      // A previous staged-but-not-yet-applied update is superseded.
      await fsp.rm(pendingPath, { force: true });
      await fsp.rm(pendingDir, { recursive: true, force: true });
      await fsp.mkdir(pendingDir, { recursive: true });

      // 1. Download every file, hashing as it streams.
      for (const [index, channel] of plan.channels.entries()) {
        const zipPath = path.join(pendingDir, `${channel.id}.zip`);
        const hash = crypto.createHash('sha256');
        const received = await downloadToFile(
          channel.url,
          zipPath,
          (bytes, total) => emit({ phase: 'download', id: channel.id, index, received: bytes, total: channel.bytes || total }),
          controller.signal,
          { hash, expectedBytes: channel.bytes },
        );
        if (channel.bytes > 0 && received !== channel.bytes) {
          throw new Error(`Downloaded ${channel.id} file is ${received} bytes, expected ${channel.bytes}.`);
        }
        if (hash.digest('hex') !== channel.sha256) {
          throw new Error(`Downloaded ${channel.id} file failed checksum verification.`);
        }
      }

      // 2. First update only: copy the bundled content out so there is
      //    something to update. It is what this shell already runs, so it
      //    is recorded as confirmed.
      if (!bootstrapped) {
        await core.bootstrapActive(
          otaFs,
          activeDir => copyTree(options.bundledDistDir, path.join(root, activeDir), copied => emit({ phase: 'prepare', received: copied, total: seedBytes }), controller.signal),
          plan.bundledVersions,
          { confirmed: true, shellIdentity: identity, log },
        );
      }

      // 3. Unzip each file into its staging directory.
      for (const [index, channel] of plan.channels.entries()) {
        throwIfCancelled();
        emit({ phase: 'unpack', id: channel.id, index });
        const zipPath = path.join(pendingDir, `${channel.id}.zip`);
        const expect = {};
        if (channel.bytes > 0) {
          expect.bytes = channel.bytes;
        }
        if (channel.entries !== null) {
          expect.entries = channel.entries;
        }
        await core.stageChannel(otaFs, channel.id, zipPath, channel.version, { expect, log });
        await fsp.rm(zipPath, { force: true });
      }
      throwIfCancelled();

      // 4. Record it. From here the next launch applies it.
      const pending = {
        identity,
        version: plan.version,
        buildNumber: plan.buildNumber,
        channels: Object.fromEntries(plan.channels.map(c => [c.id, c.version])),
      };
      await fsp.writeFile(`${pendingPath}.tmp`, JSON.stringify(pending), 'utf8');
      await renameWithRetry(`${pendingPath}.tmp`, pendingPath);
      completed = true;
      lastCheck = null;
      return { version: plan.version, buildNumber: plan.buildNumber };
    } finally {
      if (!completed) {
        // Leave nothing half-staged behind.
        for (const channel of plan.channels) {
          await core.discardStaged(otaFs, channel.id).catch(() => {});
        }
        await fsp.rm(pendingPath, { force: true }).catch(() => {});
        await fsp.rm(`${pendingPath}.tmp`, { force: true }).catch(() => {});
      }
      await fsp.rm(pendingDir, { recursive: true, force: true }).catch(() => {});
      activeController = null;
      activeSignal = undefined;
      releaseLock();
    }
  }

  function cancelDownload() {
    activeController?.abort();
  }

  return {
    enabled,
    root,
    bundledIndex,
    prepareLaunch,
    noteLoadFinished,
    noteLoadFailed,
    noteTitleScreen,
    hasReachedTitle,
    shutdown,
    check,
    download,
    cancelDownload,
  };
}

// ── Electron wiring ──────────────────────────────────────────────────────

let ipcRegistered = false;

/**
 * Registers the renderer-facing channels (see preload.cjs):
 *   ota-check (version, buildNumber)  -> check() result
 *   ota-download                      -> stages the update; progress on 'ota-progress'
 *   ota-cancel                        -> aborts an in-flight ota-download
 *   ota-restart                       -> relaunches so the staged update is applied
 * and confirms a good boot off the existing 'title-screen-state' message.
 */
function registerDesktopOtaIpc(engine, { getWindow, relaunch }) {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;
  const { ipcMain } = require('electron');

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  ipcMain.handle('ota-check', async (_event, installedVersion, installedBuildNumber) => {
    if (typeof installedVersion !== 'string' || !Number.isInteger(installedBuildNumber)) {
      return { kind: 'binary' };
    }
    try {
      return await engine.check(installedVersion, installedBuildNumber);
    } catch (err) {
      // Offline, rate-limited, unexpected response: leave it to the
      // full-binary updater, which reports its own errors.
      console.warn('Content update check failed:', err);
      return { kind: 'binary' };
    }
  });

  ipcMain.handle('ota-download', () => engine.download(progress => send('ota-progress', progress)));

  ipcMain.on('ota-cancel', () => engine.cancelDownload());

  ipcMain.handle('ota-restart', () => relaunch());

  ipcMain.on('title-screen-state', (_event, isTitleScreen) => {
    if (isTitleScreen) {
      engine.noteTitleScreen();
    }
  });
}

module.exports = {
  createDesktopOta,
  registerDesktopOtaIpc,
  getShellFingerprint,
  // exported for tests
  unzipTo,
  createNodeOtaFs,
  copyTree,
};
