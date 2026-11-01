/**
 * Generalizes mobile-updater.ts's single-bundle stage/activate/confirm/
 * rollback lifecycle (see that file's doc comment) into three independent
 * channels - code, assets, locales - so a release that only changed code
 * doesn't force re-downloading the (much larger) assets/locales bundles,
 * and vice versa. See the "Split mobile OTA updates" plan for the full
 * rationale, including the real release-history data behind it.
 *
 * ── Why this needs no new native code ────────────────────────────────────
 * The WebView can only be pointed at ONE served directory at a time
 * (setBasePath in mobile-updater.ts), so all three channels have to end up
 * living together under a single directory, `ota/active/`. Rather than
 * composing that directory from three separately-staged version dirs
 * (which would need symlink/hardlink support this codebase doesn't have a
 * plugin for), each channel's zip is unzipped so its own files land
 * DIRECTLY under `ota/active/` - and because each channel's zip only ever
 * contains that channel's own top-level entries (code's zip never
 * contains images/, assets' zip never contains index.html - see
 * scripts/split-ota-bundle.js's classification tables), applying a
 * channel's update can never touch another channel's files.
 *
 * An update to one channel therefore reduces to: move that channel's
 * CURRENT top-level entries aside into a backup directory (a plain
 * rename - stock @capacitor/filesystem, no custom native plugin), unzip
 * the new version into a scratch staging directory, then move the staged
 * entries into `ota/active/` (also a plain rename). Both renames are
 * same-filesystem directory-entry operations, not byte copies - cheap
 * regardless of how large the channel's content is, same property
 * hardlinking would have given us, with no new native code at all.
 *
 * ── Two lifecycles, not one ──────────────────────────────────────────────
 * - BOOTSTRAP (no confirmed OTA installed yet): identical in spirit to
 *   today's single-bundle logic - unzip all three channel zips together
 *   into a fresh `ota/active/`, and on repeated boot failure, abandon the
 *   whole thing and fall back to the originally-bundled app content
 *   (never call setBasePath again) - there's nothing to roll back to
 *   PARTIALLY yet, since this is the first OTA ever applied on this
 *   install.
 * - INCREMENTAL (an OTA is already confirmed and active): each channel
 *   updates independently via the backup/stage/swap dance above. A boot
 *   failure rolls back only the channel(s) that were mid-update - the
 *   backup directory's own saved pointer (see applyChannelUpdate below)
 *   is restored verbatim, and the other, already-confirmed channels are
 *   never touched.
 */

export type ChannelName = "code" | "assets" | "locales";

export const CHANNELS: ChannelName[] = ["code", "assets", "locales"];

/**
 * Top-level `ota/active/` entries each channel owns - MUST stay in sync
 * with scripts/split-ota-bundle.js's ASSET_ENTRIES/LOCALE_ENTRIES/
 * CODE_ENTRIES tables (that script is the source of truth for what ships
 * in each channel's zip; this is a deliberate, small, rarely-changing
 * duplication rather than sharing one file across the Node CI script and
 * this app bundle). Only used here to know which entries to move aside
 * when backing up a channel before swapping in a new version - never used
 * to classify anything, since every entry actually arriving in a
 * channel's zip already belongs to that channel by construction.
 */
const CHANNEL_TOP_LEVEL_ENTRIES: Record<ChannelName, string[]> = {
  code: ["index.html", "assets", "service-worker.js", "favicon.ico", "robots.txt"],
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
  ],
  locales: ["locales"],
};

export interface ChannelPointer {
  version: string;
  bootAttempts: number;
  confirmed: boolean;
}

const OTA_DIR = "ota";
const ACTIVE_DIR = `${OTA_DIR}/active`;
const BOOT_ATTEMPT_THRESHOLD = 2;

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

function cap(): any {
  return typeof window !== "undefined" ? (window as any).Capacitor : undefined;
}

function filesystem(): any {
  return cap()?.Plugins?.Filesystem;
}

function otaUnzip(): any {
  return cap()?.Plugins?.OtaUnzip;
}

async function readJson<T>(fs: any, path: string): Promise<T | null> {
  try {
    const { data } = await fs.readFile({ path, directory: "DATA", encoding: "utf8" });
    return JSON.parse(data as string);
  } catch {
    return null;
  }
}

async function writeJson(fs: any, path: string, value: unknown): Promise<void> {
  await fs.writeFile({ path, data: JSON.stringify(value), directory: "DATA", encoding: "utf8", recursive: true });
}

export async function readChannelPointer(fs: any, channel: ChannelName): Promise<ChannelPointer | null> {
  return readJson<ChannelPointer>(fs, pointerPath(channel));
}

async function writeChannelPointer(fs: any, channel: ChannelName, pointer: ChannelPointer): Promise<void> {
  await writeJson(fs, pointerPath(channel), pointer);
}

async function rmrf(fs: any, path: string): Promise<void> {
  await fs.rmdir({ path, directory: "DATA", recursive: true }).catch(() => {});
}

/**
 * Moves `entries` (top-level names under `fromDir`) into the same-named
 * paths under `toDir`, via the stock Filesystem.rename - a plain
 * directory-entry move, not a byte copy. Entries that don't currently
 * exist under `fromDir` are skipped (e.g. a channel's very first apply
 * has nothing yet to move aside).
 */
async function moveEntries(fs: any, entries: string[], fromDir: string, toDir: string): Promise<void> {
  await fs.mkdir({ path: toDir, directory: "DATA", recursive: true }).catch(() => {});
  for (const entry of entries) {
    const from = `${fromDir}/${entry}`;
    const to = `${toDir}/${entry}`;
    try {
      await fs.stat({ path: from, directory: "DATA" });
    } catch {
      continue; // nothing to move for this entry
    }
    await fs.rename({ from, to, directory: "DATA", toDirectory: "DATA" });
  }
}

/** True once a confirmed OTA has ever been activated on this install - see the two-lifecycles note above. */
export async function isOtaBootstrapped(fs: any): Promise<boolean> {
  for (const channel of CHANNELS) {
    if (await readChannelPointer(fs, channel)) {
      return true;
    }
  }
  return false;
}

/**
 * First-ever OTA apply: unzips all three downloaded channel zips directly
 * into a fresh `ota/active/`, then writes all three pointers unconfirmed.
 * Mirrors today's single-bundle stageAndActivateOta() almost exactly - the
 * only difference is three unzip calls into the same destDir instead of
 * one, which is safe precisely because each zip only contains its own
 * channel's entries (see this file's doc comment).
 */
export async function bootstrapActive(channelZipPaths: Record<ChannelName, string>, versions: Record<ChannelName, string>): Promise<string> {
  const fs = filesystem();
  const unzip = otaUnzip();
  if (!fs || !unzip) {
    throw new Error("Capacitor Filesystem/OtaUnzip plugin not available.");
  }

  await rmrf(fs, ACTIVE_DIR); // abandon any half-written previous bootstrap attempt
  const { uri } = await fs.getUri({ path: ACTIVE_DIR, directory: "DATA" });

  try {
    for (const channel of CHANNELS) {
      const { entryCount } = await unzip.unzip({ sourcePath: channelZipPaths[channel], destDir: uri });
      console.log(`[ota-parts] bootstrapActive: unzipped ${channel} (${entryCount} entries) into ${uri}`);
    }
  } catch (err) {
    console.error(`[ota-parts] bootstrapActive: unzip failed, abandoning ${ACTIVE_DIR}:`, err);
    await rmrf(fs, ACTIVE_DIR);
    throw err;
  }

  // Point of no return for the bootstrap path - everything above is
  // abandonable (the previously-bundled app content is still what's
  // served until a pointer is written and reapplyActivePartsIfAny() runs).
  for (const channel of CHANNELS) {
    await writeChannelPointer(fs, channel, { version: versions[channel], bootAttempts: 0, confirmed: false });
  }

  return uri;
}

/**
 * Incremental update to ONE channel, once an OTA is already bootstrapped.
 * Backs the channel's current entries AND current pointer up (so a boot
 * failure can restore both verbatim), unzips the new version into a
 * scratch staging dir, then swaps staged entries into `ota/active/`.
 * Leaves the other two channels completely untouched on disk.
 */
export async function applyChannelUpdate(channel: ChannelName, zipPath: string, newVersion: string): Promise<void> {
  const fs = filesystem();
  const unzip = otaUnzip();
  if (!fs || !unzip) {
    throw new Error("Capacitor Filesystem/OtaUnzip plugin not available.");
  }

  const entries = CHANNEL_TOP_LEVEL_ENTRIES[channel];
  const staging = stagingDirPath(channel);
  const backup = backupDirPath(channel);

  await rmrf(fs, staging); // abandon any half-written previous attempt for this channel
  const { uri: stagingUri } = await fs.getUri({ path: staging, directory: "DATA" });

  try {
    const { entryCount } = await unzip.unzip({ sourcePath: zipPath, destDir: stagingUri });
    console.log(`[ota-parts] applyChannelUpdate(${channel}): unzipped ${entryCount} entries into ${stagingUri}`);
  } catch (err) {
    console.error(`[ota-parts] applyChannelUpdate(${channel}): unzip failed, abandoning staging dir:`, err);
    await rmrf(fs, staging);
    throw err;
  }

  // Save what's currently installed for this channel (files AND pointer)
  // before touching anything live - this is what a boot failure restores.
  await rmrf(fs, backup);
  const previousPointer = await readChannelPointer(fs, channel);
  await moveEntries(fs, entries, ACTIVE_DIR, backup);
  if (previousPointer) {
    await writeJson(fs, backupPointerPath(channel), previousPointer);
  }

  // Point of no return for this channel - the backup above is now the
  // only copy of the previous version; everything from here swaps the new
  // one in.
  await moveEntries(fs, entries, staging, ACTIVE_DIR);
  await rmrf(fs, staging);
  await writeChannelPointer(fs, channel, { version: newVersion, bootAttempts: 0, confirmed: false });
  console.log(`[ota-parts] applyChannelUpdate(${channel}): swapped in version ${newVersion}`);
}

/** Restores a channel's previous files+pointer from its backup (see applyChannelUpdate), or just abandons it if this was the channel's first-ever apply (no backup exists). */
async function rollbackChannel(fs: any, channel: ChannelName): Promise<void> {
  const entries = CHANNEL_TOP_LEVEL_ENTRIES[channel];
  const backup = backupDirPath(channel);
  const previousPointer = await readJson<ChannelPointer>(fs, backupPointerPath(channel));

  await moveEntries(fs, entries, ACTIVE_DIR, `${OTA_DIR}/discarded-${channel}`); // move the broken version out of the way first
  await rmrf(fs, `${OTA_DIR}/discarded-${channel}`);

  if (previousPointer) {
    await moveEntries(fs, entries, backup, ACTIVE_DIR);
    await writeChannelPointer(fs, channel, previousPointer);
    console.warn(`[ota-parts] rollbackChannel(${channel}): restored previous version ${previousPointer.version}`);
  } else {
    // First-ever apply of this channel failed to boot - nothing to roll
    // back to. This only matters post-bootstrap (a channel updated for
    // the first time after bootstrap, as opposed to all three failing
    // together during bootstrap itself - see reapplyActivePartsIfAny).
    await fs.deleteFile({ path: pointerPath(channel), directory: "DATA" }).catch(() => {});
    console.warn(`[ota-parts] rollbackChannel(${channel}): no backup to restore - channel left empty`);
  }
  await rmrf(fs, backup);
  await fs.deleteFile({ path: backupPointerPath(channel), directory: "DATA" }).catch(() => {});
}

/**
 * Boot hook - call once, early, on every cold launch (gated on
 * Capacitor.isNativePlatform()), same as today's
 * reapplyActiveOtaBundleIfAny(). Rolls back any channel that's repeatedly
 * failed to confirm, then (if `ota/active/` exists at all) calls
 * setBasePath exactly once for the whole directory - never once per
 * channel, since both platforms' setServerBasePath forces an immediate
 * WebView reload every call (see mobile-updater.ts's
 * OTA_REAPPLIED_SESSION_KEY comment for the loop that caused on-device).
 */
export async function reapplyActivePartsIfAny(setBasePath: (path: string) => Promise<void>): Promise<void> {
  const fs = filesystem();
  if (!fs) {
    return;
  }

  let anyPointerExists = false;
  for (const channel of CHANNELS) {
    const pointer = await readChannelPointer(fs, channel);
    if (!pointer) {
      continue;
    }
    anyPointerExists = true;

    if (!pointer.confirmed && pointer.bootAttempts >= BOOT_ATTEMPT_THRESHOLD) {
      console.warn(`[ota-parts] reapplyActivePartsIfAny: ${channel} never confirmed after ${pointer.bootAttempts} attempts - rolling back`);
      await rollbackChannel(fs, channel);
      continue;
    }

    await writeChannelPointer(fs, channel, { ...pointer, bootAttempts: pointer.bootAttempts + 1 });
  }

  // If every channel just got abandoned on its very first (bootstrap)
  // apply, ota/active/ may now be empty/partial - same "fall through to
  // bundled assets" behavior as today when nothing is left to serve.
  const anyPointerLeft = (await Promise.all(CHANNELS.map(c => readChannelPointer(fs, c)))).some(Boolean);
  if (!anyPointerLeft) {
    if (anyPointerExists) {
      await rmrf(fs, ACTIVE_DIR);
    }
    return;
  }

  const { uri } = await fs.getUri({ path: ACTIVE_DIR, directory: "DATA" });
  await setBasePath(uri);
}

/** Call once gameplay/title-screen readiness is reached. Confirms every unconfirmed channel and clears its now-superseded backup. */
export async function confirmPartsBootSuccess(): Promise<void> {
  const fs = filesystem();
  if (!fs) {
    return;
  }
  for (const channel of CHANNELS) {
    const pointer = await readChannelPointer(fs, channel);
    if (!pointer || pointer.confirmed) {
      continue;
    }
    await writeChannelPointer(fs, channel, { ...pointer, confirmed: true, bootAttempts: 0 });
    await rmrf(fs, backupDirPath(channel));
    await fs.deleteFile({ path: backupPointerPath(channel), directory: "DATA" }).catch(() => {});
  }
}
