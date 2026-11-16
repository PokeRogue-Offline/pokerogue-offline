/**
 * Platform-independent OTA state machine, shared by mobile (Capacitor
 * renderer, via ota-parts.ts) and desktop (Electron main process, via
 * configs/desktop/electron/ota-desktop.cjs).
 *
 * This file must stay dependency-free and use only erasable TypeScript
 * syntax (no enums, no parameter properties, no imports): the desktop
 * build transpiles it to CommonJS with scripts/transpile-ota-core.js, and
 * the mobile build compiles it with the rest of the app. Everything that
 * touches a real filesystem goes through the OtaFs adapter, so the whole
 * machine can be driven against an in-memory filesystem in tests.
 *
 * ── Layout (all paths relative to the adapter's root) ────────────────────
 *   ota/active/                 the one served directory (all channels)
 *   ota/active-<ch>.json        channel pointer
 *   ota/backup-<ch>/            last CONFIRMED version of the channel
 *   ota/backup-<ch>.json        pointer that goes with that backup
 *   ota/staging-<ch>/           scratch unzip target
 *   ota/staged-<ch>.json        says staging-<ch>/ holds a complete version
 *   ota/discarded-<ch>/         scratch for entries being thrown away
 *   ota/inprogress-<ch>.json    write-ahead marker for a swap or rollback
 *   ota/inprogress-bootstrap.json  write-ahead marker for a bootstrap
 *   ota/shell.json              identity of the native shell this content
 *                               was installed under
 *
 * ── Crash safety ─────────────────────────────────────────────────────────
 * Moving a channel's entries between directories is several renames, so it
 * is not atomic as a group. Before the first rename, a marker is written
 * that records everything needed to undo the swap: which entries the
 * backup will hold and which pointer goes with them. The marker is removed
 * only after the new pointer is on disk. Boot runs recoverInProgress()
 * first: a marker whose pointer was already written is finished (roll
 * forward), any other marker is undone from the backup (roll back). Every
 * recovery step is idempotent, so a crash during recovery is recovered by
 * simply running it again.
 *
 * Rollback after repeated failed boots goes through the same marker, for
 * the same reason.
 */

export type ChannelName = "code" | "assets" | "locales";

export const CHANNELS: ChannelName[] = ["code", "assets", "locales"];

/**
 * Top-level `ota/active/` entries each channel owns. MUST stay in sync
 * with scripts/split-ota-bundle.js (ASSET_ENTRIES / LOCALE_ENTRIES /
 * CODE_ENTRIES).
 */
export const CHANNEL_TOP_LEVEL_ENTRIES: Record<ChannelName, string[]> = {
  code: ["index.html", "assets", "service-worker.js", "favicon.ico", "robots.txt", "asset-manifest.json"],
  assets: [
    "images",
    "audio",
    "fonts",
    "battle-anims",
    "logo128.png",
    "logo512.png",
    "manifest.webmanifest",
    "biome-bgm-loop-points.json",
    "exp-sprites.json",
    "starter-colors.json",
    "test",
  ],
  locales: ["locales"],
};

export interface ChannelPointer {
  version: string;
  /** Launches attempted on this version since it was applied (unconfirmed pointers only). */
  bootAttempts: number;
  confirmed: boolean;
  /** How many of those launches got as far as running the new content. */
  loadedAttempts?: number;
  /** Id of the apply/bootstrap that wrote this pointer; ties it to its marker. */
  applyId?: string;
}

export interface UnzipExpectation {
  /** Exact size of the zip file. Checked before unzipping. */
  bytes?: number;
  /** Number of file entries the zip must contain. Checked after unzipping. */
  entries?: number;
}

/** Everything the state machine needs from a filesystem. Paths are relative to the adapter's root. */
export interface OtaFs {
  /** Null when the file is missing or unreadable. */
  readText(path: string): Promise<string | null>;
  /** Creates parent directories as needed. */
  writeText(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Same-filesystem move of a file or directory. The destination must not exist. */
  rename(from: string, to: string): Promise<void>;
  /** Removes a file or directory tree. Never fails when the path is already gone. */
  rmrf(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  /** Unzips `zipPath` (adapter-defined location) into `destDir`, stripping the zip's single leading path segment. */
  unzip(zipPath: string, destDir: string, expect?: UnzipExpectation): Promise<{ entryCount: number }>;
}

export type OtaLog = (message: string) => void;

interface SwapMarker {
  op: "apply" | "rollback";
  id: string;
  newVersion?: string;
  /** Entries the backup directory holds (or will hold) for this operation. */
  backedUp: string[];
  /** Pointer that describes the backup's contents; null when there is no version to go back to. */
  restorePointer: ChannelPointer | null;
}

interface StagedStamp {
  version: string;
}

interface BootstrapMarker {
  id: string;
}

export const OTA_DIR = "ota";
export const ACTIVE_DIR = `${OTA_DIR}/active`;
const SHELL_PATH = `${OTA_DIR}/shell.json`;
const BOOTSTRAP_MARKER_PATH = `${OTA_DIR}/inprogress-bootstrap.json`;

/**
 * An unconfirmed version is rolled back after this many launches that
 * never got as far as running the new content at all...
 */
export const HARD_FAILURE_THRESHOLD = 2;
/**
 * ...or after this many launches that did run it but never reached the
 * title screen. The second number is deliberately larger: a launch that
 * runs the new content and is then closed during a slow first load is far
 * more likely to be an impatient user than a broken update, and the old
 * single threshold of 2 rolled good updates back in exactly that case.
 * Five such launches in a row without ever reaching the title screen is
 * still treated as broken.
 */
export const LOADED_FAILURE_THRESHOLD = 5;

function pointerPath(channel: ChannelName): string {
  return `${OTA_DIR}/active-${channel}.json`;
}
function backupPointerPath(channel: ChannelName): string {
  return `${OTA_DIR}/backup-${channel}.json`;
}
function backupDirPath(channel: ChannelName): string {
  return `${OTA_DIR}/backup-${channel}`;
}
function stagingDirPath(channel: ChannelName): string {
  return `${OTA_DIR}/staging-${channel}`;
}
function discardedDirPath(channel: ChannelName): string {
  return `${OTA_DIR}/discarded-${channel}`;
}
function stagedStampPath(channel: ChannelName): string {
  return `${OTA_DIR}/staged-${channel}.json`;
}
function markerPath(channel: ChannelName): string {
  return `${OTA_DIR}/inprogress-${channel}.json`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseJsonObject<T>(text: string | null): T | null {
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null; // a torn write
  }
}

/**
 * State files are written twice - first to `<path>.new`, then to `<path>` -
 * because neither platform's plain file write is atomic and a kill in the
 * middle of one leaves a truncated file. Whichever of the two the kill
 * lands in, the other copy is complete: the old value if `.new` was torn,
 * the new value if the main file was. Readers use the main file and fall
 * back to `.new` (repairing the main file from it) only when the main file
 * is missing or torn; a complete `.new` next to a good main file is a
 * write that was cut off before it started on the main file, and is
 * simply overwritten by the next write.
 */
async function readJson<T>(fs: OtaFs, path: string): Promise<T | null> {
  const current = parseJsonObject<T>(await fs.readText(path));
  if (current) {
    return current;
  }
  const pendingText = await fs.readText(`${path}.new`);
  const pending = parseJsonObject<T>(pendingText);
  if (pending && pendingText !== null) {
    // The main copy was torn or never written. Repair it now, so the next
    // write (which starts by overwriting `.new`) always has one good copy.
    await fs.writeText(path, pendingText);
    await fs.rmrf(`${path}.new`);
  }
  return pending;
}

async function writeJson(fs: OtaFs, path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  await fs.writeText(`${path}.new`, text);
  await fs.writeText(path, text);
  await fs.rmrf(`${path}.new`);
}

/** Removes a state file written by writeJson(). The `.new` copy goes first so it can never bring the value back. */
async function removeJson(fs: OtaFs, path: string): Promise<void> {
  await fs.rmrf(`${path}.new`);
  await fs.rmrf(path);
}

export async function readChannelPointer(fs: OtaFs, channel: ChannelName): Promise<ChannelPointer | null> {
  const pointer = await readJson<ChannelPointer>(fs, pointerPath(channel));
  return pointer && typeof pointer.version === "string" ? pointer : null;
}

async function writeChannelPointer(fs: OtaFs, channel: ChannelName, pointer: ChannelPointer): Promise<void> {
  await writeJson(fs, pointerPath(channel), pointer);
}

/** True when all three channels have a pointer, i.e. `ota/active/` is a complete set. */
export async function isOtaBootstrapped(fs: OtaFs): Promise<boolean> {
  for (const channel of CHANNELS) {
    if (!(await readChannelPointer(fs, channel))) {
      return false;
    }
  }
  return true;
}

async function existingEntries(fs: OtaFs, entries: string[], dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of entries) {
    if (await fs.exists(`${dir}/${entry}`)) {
      found.push(entry);
    }
  }
  return found;
}

/** Moves each of `entries` that exists under `fromDir` to the same name under `toDir`. */
async function moveEntries(fs: OtaFs, entries: string[], fromDir: string, toDir: string): Promise<void> {
  await fs.mkdirp(toDir);
  for (const entry of entries) {
    const from = `${fromDir}/${entry}`;
    if (!(await fs.exists(from))) {
      continue;
    }
    const to = `${toDir}/${entry}`;
    await fs.rmrf(to);
    await fs.rename(from, to);
  }
}

/** Removes every trace of OTA state, so the app falls back to its bundled content. */
export async function wipeAll(fs: OtaFs): Promise<void> {
  // Pointers first: once they are gone nothing will try to serve
  // `ota/active/`, however far the rest of the cleanup gets.
  for (const channel of CHANNELS) {
    await removeJson(fs, pointerPath(channel));
  }
  await fs.rmrf(ACTIVE_DIR);
  for (const channel of CHANNELS) {
    await fs.rmrf(backupDirPath(channel));
    await removeJson(fs, backupPointerPath(channel));
    await discardStaged(fs, channel);
    await fs.rmrf(discardedDirPath(channel));
    await removeJson(fs, markerPath(channel));
  }
  await removeJson(fs, SHELL_PATH);
  await removeJson(fs, BOOTSTRAP_MARKER_PATH);
}

export interface BootstrapOptions {
  /** Pointers are written confirmed. Only for content that is already known to boot (desktop seeding from the bundled dist). */
  confirmed?: boolean;
  /** Recorded so a later boot under a different native shell discards this content. */
  shellIdentity?: string | null;
  log?: OtaLog;
}

/**
 * First install of OTA content: wipes any previous state, lets `populate`
 * fill a fresh `ota/active/`, then writes all three pointers. A crash at
 * any point leaves the bootstrap marker behind, and the next boot wipes
 * the partial result instead of serving it.
 */
export async function bootstrapActive(
  fs: OtaFs,
  populate: (activeDir: string) => Promise<void>,
  versions: Record<ChannelName, string>,
  options: BootstrapOptions = {},
): Promise<void> {
  const id = newId();
  const marker: BootstrapMarker = { id };
  await writeJson(fs, BOOTSTRAP_MARKER_PATH, marker);

  // Same order as wipeAll(), minus the marker just written.
  for (const channel of CHANNELS) {
    await removeJson(fs, pointerPath(channel));
  }
  await fs.rmrf(ACTIVE_DIR);
  for (const channel of CHANNELS) {
    await fs.rmrf(backupDirPath(channel));
    await removeJson(fs, backupPointerPath(channel));
    await discardStaged(fs, channel);
    await fs.rmrf(discardedDirPath(channel));
    await removeJson(fs, markerPath(channel));
  }
  await removeJson(fs, SHELL_PATH);

  try {
    await fs.mkdirp(ACTIVE_DIR);
    await populate(ACTIVE_DIR);
  } catch (err) {
    options.log?.(`bootstrapActive: populate failed, abandoning ${ACTIVE_DIR}`);
    await fs.rmrf(ACTIVE_DIR);
    await removeJson(fs, BOOTSTRAP_MARKER_PATH);
    throw err;
  }

  if (options.shellIdentity) {
    await writeJson(fs, SHELL_PATH, { identity: options.shellIdentity });
  }
  for (const channel of CHANNELS) {
    await writeChannelPointer(fs, channel, {
      version: versions[channel],
      bootAttempts: 0,
      loadedAttempts: 0,
      confirmed: options.confirmed === true,
      applyId: id,
    });
  }
  await removeJson(fs, BOOTSTRAP_MARKER_PATH);
}

export interface ApplyOptions {
  expect?: UnzipExpectation | undefined;
  log?: OtaLog | undefined;
}

/** Throws away whatever is staged for the channel, complete or not. */
export async function discardStaged(fs: OtaFs, channel: ChannelName): Promise<void> {
  // Stamp first: without it the directory is just scratch space.
  await removeJson(fs, stagedStampPath(channel));
  await fs.rmrf(stagingDirPath(channel));
}

/** The version fully staged for the channel and waiting to be swapped in, or null. */
export async function readStagedVersion(fs: OtaFs, channel: ChannelName): Promise<string | null> {
  const stamp = await readJson<StagedStamp>(fs, stagedStampPath(channel));
  return stamp && typeof stamp.version === "string" ? stamp.version : null;
}

/**
 * Step 1 of an update: unzips `zipPath` into the channel's staging
 * directory and stamps it as complete. Nothing live is touched, so this is
 * safe to do while the current content is in use, and a failure or a kill
 * part-way is simply abandoned (no stamp, so the directory is never used).
 */
export async function stageChannel(fs: OtaFs, channel: ChannelName, zipPath: string, newVersion: string, options: ApplyOptions = {}): Promise<void> {
  const staging = stagingDirPath(channel);
  await discardStaged(fs, channel);
  try {
    await fs.mkdirp(staging);
    const { entryCount } = await fs.unzip(zipPath, staging, options.expect);
    if (options.expect?.entries !== undefined && entryCount !== options.expect.entries) {
      throw new Error(`OTA ${channel} zip is incomplete: expected ${options.expect.entries} entries, got ${entryCount}.`);
    }
    options.log?.(`stageChannel(${channel}): staged ${entryCount} entries`);
  } catch (err) {
    await fs.rmrf(staging);
    throw err;
  }
  const stamp: StagedStamp = { version: newVersion };
  await writeJson(fs, stagedStampPath(channel), stamp);
}

/**
 * Step 2 of an update: swaps the staged version of ONE channel into
 * `ota/active/`. Only renames - no unzipping - so it is quick however
 * large the channel is. The other two channels are not touched.
 *
 * The backup always ends up holding the last CONFIRMED version: when the
 * version being replaced never confirmed, it is thrown away and the backup
 * that was taken before it is kept.
 */
export async function swapStagedChannel(fs: OtaFs, channel: ChannelName, newVersion: string, options: { log?: OtaLog | undefined } = {}): Promise<void> {
  const entries = CHANNEL_TOP_LEVEL_ENTRIES[channel];
  const staging = stagingDirPath(channel);
  const backup = backupDirPath(channel);
  const discarded = discardedDirPath(channel);

  if ((await readStagedVersion(fs, channel)) !== newVersion) {
    throw new Error(`No staged ${channel} content for version ${newVersion}.`);
  }

  // 2. Decide what the backup will be, before anything moves.
  const previousPointer = await readChannelPointer(fs, channel);
  const backupPointer = await readJson<ChannelPointer>(fs, backupPointerPath(channel));
  const keepBackup = !!previousPointer && !previousPointer.confirmed && !!backupPointer;
  if (!keepBackup) {
    // Whatever is in the backup dir is superseded (the live version is
    // confirmed) or orphaned (no pointer describes it). The live content
    // is intact and no marker exists yet, so a crash here costs nothing.
    await removeJson(fs, backupPointerPath(channel));
    await fs.rmrf(backup);
  }
  await fs.rmrf(discarded);

  const id = newId();
  const marker: SwapMarker = {
    op: "apply",
    id,
    newVersion,
    backedUp: await existingEntries(fs, entries, keepBackup ? backup : ACTIVE_DIR),
    restorePointer: keepBackup ? backupPointer : previousPointer,
  };

  // 3. Write-ahead marker. From here until it is removed, boot recovery
  //    owns this channel.
  await writeJson(fs, markerPath(channel), marker);

  // 4. Move the live entries out of the way.
  if (keepBackup) {
    await moveEntries(fs, entries, ACTIVE_DIR, discarded);
  } else {
    if (previousPointer) {
      await writeJson(fs, backupPointerPath(channel), previousPointer);
    }
    await moveEntries(fs, entries, ACTIVE_DIR, backup);
  }

  // 5. Move the staged entries in.
  await moveEntries(fs, entries, staging, ACTIVE_DIR);
  await discardStaged(fs, channel);
  await fs.rmrf(discarded);

  // 6. Commit: the pointer names the new version and carries the marker's id.
  await writeChannelPointer(fs, channel, { version: newVersion, bootAttempts: 0, loadedAttempts: 0, confirmed: false, applyId: id });

  // 7. Done.
  await removeJson(fs, markerPath(channel));
  options.log?.(`swapStagedChannel(${channel}): swapped in version ${newVersion}`);
}

/** Stage, then swap: replaces ONE channel's content with the version in `zipPath` in one go. */
export async function applyChannelUpdate(fs: OtaFs, channel: ChannelName, zipPath: string, newVersion: string, options: ApplyOptions = {}): Promise<void> {
  await stageChannel(fs, channel, zipPath, newVersion, options);
  await swapStagedChannel(fs, channel, newVersion, options);
}

/**
 * Puts the channel back to what the marker's backup describes. Safe to run
 * any number of times, from any point of a previous run.
 */
async function restoreFromMarker(fs: OtaFs, channel: ChannelName, marker: SwapMarker, log?: OtaLog): Promise<void> {
  const backup = backupDirPath(channel);
  const backedUp = Array.isArray(marker.backedUp) ? marker.backedUp : [];

  for (const entry of CHANNEL_TOP_LEVEL_ENTRIES[channel]) {
    const live = `${ACTIVE_DIR}/${entry}`;
    if (backedUp.includes(entry)) {
      // Still in the backup: whatever is live under this name is not the
      // version being restored. Already gone from the backup: it was never
      // moved out, or an earlier run of this function already put it back.
      if (await fs.exists(`${backup}/${entry}`)) {
        await fs.rmrf(live);
        await fs.mkdirp(ACTIVE_DIR);
        await fs.rename(`${backup}/${entry}`, live);
      }
    } else {
      // The restored version has no such entry.
      await fs.rmrf(live);
    }
  }

  if (marker.restorePointer) {
    await writeChannelPointer(fs, channel, marker.restorePointer);
    log?.(`restore(${channel}): back on version ${marker.restorePointer.version}`);
  } else {
    await removeJson(fs, pointerPath(channel));
    log?.(`restore(${channel}): no version to go back to - channel removed`);
  }

  await removeJson(fs, backupPointerPath(channel));
  await fs.rmrf(backup);
  await discardStaged(fs, channel);
  await fs.rmrf(discardedDirPath(channel));
  await removeJson(fs, markerPath(channel));
}

/** Undoes an unconfirmed version that keeps failing to boot. */
async function rollbackChannel(fs: OtaFs, channel: ChannelName, log?: OtaLog): Promise<void> {
  const backupPointer = await readJson<ChannelPointer>(fs, backupPointerPath(channel));
  const marker: SwapMarker = {
    op: "rollback",
    id: newId(),
    backedUp: backupPointer ? await existingEntries(fs, CHANNEL_TOP_LEVEL_ENTRIES[channel], backupDirPath(channel)) : [],
    restorePointer: backupPointer,
  };
  await writeJson(fs, markerPath(channel), marker);
  await restoreFromMarker(fs, channel, marker, log);
}

/**
 * Finishes or undoes whatever a previous process was in the middle of.
 * Must run before anything reads the pointers on boot.
 */
export async function recoverInProgress(fs: OtaFs, log?: OtaLog): Promise<void> {
  const bootstrapMarker = await readJson<BootstrapMarker>(fs, BOOTSTRAP_MARKER_PATH);
  if (bootstrapMarker) {
    let complete = true;
    for (const channel of CHANNELS) {
      const pointer = await readChannelPointer(fs, channel);
      if (!pointer || pointer.applyId !== bootstrapMarker.id) {
        complete = false;
      }
    }
    if (complete) {
      await removeJson(fs, BOOTSTRAP_MARKER_PATH);
    } else {
      log?.("recoverInProgress: interrupted bootstrap - discarding it");
      await wipeAll(fs);
    }
  } else {
    await removeJson(fs, BOOTSTRAP_MARKER_PATH); // clears a torn leftover, if any
  }

  for (const channel of CHANNELS) {
    const marker = await readJson<SwapMarker>(fs, markerPath(channel));
    if (!marker) {
      await removeJson(fs, markerPath(channel)); // clears a torn leftover, if any
      continue;
    }
    const pointer = await readChannelPointer(fs, channel);
    if (marker.op === "apply" && pointer && pointer.applyId === marker.id) {
      log?.(`recoverInProgress(${channel}): swap had committed - finishing it`);
      await discardStaged(fs, channel);
      await fs.rmrf(discardedDirPath(channel));
      await removeJson(fs, markerPath(channel));
    } else {
      log?.(`recoverInProgress(${channel}): interrupted ${marker.op} - restoring the backup`);
      await restoreFromMarker(fs, channel, marker, log);
    }
  }

  // A staging directory without its stamp is an unzip that never finished.
  // It will never be used, and can be hundreds of MB.
  for (const channel of CHANNELS) {
    if ((await readStagedVersion(fs, channel)) === null) {
      await discardStaged(fs, channel);
    }
  }
}

export interface BootOptions {
  /**
   * Identity of the running native shell. When it differs from the one the
   * OTA content was installed under (the app itself was reinstalled or
   * updated), the OTA content is discarded: it was built for another shell
   * and the freshly installed bundled content supersedes it. Null skips
   * the check.
   */
  shellIdentity?: string | null;
  log?: OtaLog;
}

/**
 * Boot-time bookkeeping. Returns true when `ota/active/` is a complete,
 * usable set that should be served, false when the bundled content should.
 */
export async function prepareBoot(fs: OtaFs, options: BootOptions = {}): Promise<boolean> {
  const log = options.log;
  await recoverInProgress(fs, log);

  const present: ChannelName[] = [];
  for (const channel of CHANNELS) {
    if (await readChannelPointer(fs, channel)) {
      present.push(channel);
    }
  }
  if (present.length === 0) {
    return false;
  }

  if (options.shellIdentity) {
    const shell = await readJson<{ identity?: string }>(fs, SHELL_PATH);
    if (!shell || shell.identity !== options.shellIdentity) {
      log?.("prepareBoot: OTA content belongs to a different app build - discarding it");
      await wipeAll(fs);
      return false;
    }
  }

  if (present.length !== CHANNELS.length) {
    log?.("prepareBoot: incomplete channel set - discarding it");
    await wipeAll(fs);
    return false;
  }

  for (const channel of CHANNELS) {
    const pointer = await readChannelPointer(fs, channel);
    if (!pointer || pointer.confirmed) {
      continue;
    }
    const loaded = pointer.loadedAttempts ?? 0;
    const hard = pointer.bootAttempts - loaded;
    if (hard >= HARD_FAILURE_THRESHOLD || loaded >= LOADED_FAILURE_THRESHOLD) {
      log?.(`prepareBoot: ${channel} never confirmed (${pointer.bootAttempts} launches, ${loaded} reached the new content) - rolling back`);
      await rollbackChannel(fs, channel, log);
      continue;
    }
    await writeChannelPointer(fs, channel, { ...pointer, bootAttempts: pointer.bootAttempts + 1 });
  }

  if (!(await isOtaBootstrapped(fs)) || !(await fs.exists(`${ACTIVE_DIR}/index.html`))) {
    log?.("prepareBoot: nothing usable left after rollback - falling back to bundled content");
    await wipeAll(fs);
    return false;
  }
  return true;
}

/** Records that this launch got as far as running the OTA content. Call at most once per launch. */
export async function markLoadReached(fs: OtaFs): Promise<void> {
  for (const channel of CHANNELS) {
    const pointer = await readChannelPointer(fs, channel);
    if (!pointer || pointer.confirmed) {
      continue;
    }
    const loaded = Math.min((pointer.loadedAttempts ?? 0) + 1, pointer.bootAttempts);
    await writeChannelPointer(fs, channel, { ...pointer, loadedAttempts: loaded });
  }
}

/** The title screen was reached: every unconfirmed channel is good, and its backup is no longer needed. */
export async function confirmBootSuccess(fs: OtaFs): Promise<void> {
  for (const channel of CHANNELS) {
    if (await readJson<SwapMarker>(fs, markerPath(channel))) {
      continue; // boot recovery has not run for this channel; leave it alone
    }
    const pointer = await readChannelPointer(fs, channel);
    if (!pointer || pointer.confirmed) {
      continue;
    }
    await writeChannelPointer(fs, channel, { ...pointer, confirmed: true, bootAttempts: 0, loadedAttempts: 0 });
    await removeJson(fs, backupPointerPath(channel));
    await fs.rmrf(backupDirPath(channel));
  }
}

// ── Release selection (pure) ─────────────────────────────────────────────

export const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:\.\d+)?)-(\d+)$/;
export const DEV_TAG_PATTERN = /^dev-v(\d+\.\d+\.\d+(?:\.\d+)?)-(\d+)$/;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  /** Size in bytes, as reported by the GitHub API. */
  size?: number;
}

export interface ReleaseLike {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
}

export interface MatchedRelease {
  version: string;
  buildNumber: number;
  assets: ReleaseAsset[];
}

function extractVersion(versionString: string): number[] {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(versionString)) {
    throw new Error(`Invalid version string (${versionString}) in OTA updater!`);
  }
  const parts = versionString.split(".").map(v => Number.parseInt(v, 10));
  if (parts.length === 3) {
    parts.push(0);
  }
  return parts;
}

export function compareVersions(versionA: string, versionB: string): -1 | 0 | 1 {
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

/**
 * Picks the newest release that is ahead of the installed build, or null.
 * Stable builds only ever match `v...` tags and dev builds only `dev-v...`
 * tags, so the two channels cannot cross whatever the caller fetched.
 */
export function findApplicableRelease(releases: ReleaseLike[], installedVersion: string, installedBuildNumber: number, dev: boolean): MatchedRelease | null {
  const pattern = dev ? DEV_TAG_PATTERN : TAG_PATTERN;
  const byVersion = new Map<string, MatchedRelease>();
  for (const release of releases) {
    const match = typeof release.tag_name === "string" ? release.tag_name.match(pattern) : null;
    if (!match) {
      continue;
    }
    const version = match[1];
    const buildNumber = Number.parseInt(match[2], 10);
    const existing = byVersion.get(version);
    if (!existing || buildNumber > existing.buildNumber) {
      byVersion.set(version, { version, buildNumber, assets: release.assets || [] });
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

// ── Disk space (pure) ────────────────────────────────────────────────────

export interface ChannelSize {
  /** Size of the channel's zip. */
  bytes: number;
  /** Size of the channel's files once unzipped, when the manifest says. */
  unpackedBytes?: number | undefined;
}

/**
 * Peak extra disk an update needs: every zip is downloaded before any is
 * applied, and each channel is then unzipped next to the version it
 * replaces. The replaced version does not count - it is already on disk
 * and is only moved, not copied, into the backup. `extraBytes` covers
 * anything else the caller is about to write (desktop's first-time copy of
 * the bundled content). A 10% margin absorbs filesystem overhead.
 */
export function estimateRequiredBytes(channels: ChannelSize[], extraBytes = 0): number {
  let total = extraBytes;
  for (const channel of channels) {
    // Channel contents are mostly PNG/OGG/minified JS, which zip barely
    // shrinks; 1.5x is a safe stand-in when the manifest predates unpackedBytes.
    total += channel.bytes + (channel.unpackedBytes ?? Math.ceil(channel.bytes * 1.5));
  }
  return Math.ceil(total * 1.1);
}
