/**
 * Mobile (Capacitor) binding for the OTA state machine in ota-core.ts.
 *
 * The web content is split into three independently-updatable channels -
 * code, assets, locales - so a release that only changed code doesn't
 * force re-downloading the (much larger) assets/locales bundles.
 *
 * ── Why one served directory ─────────────────────────────────────────────
 * The WebView can only be pointed at ONE directory at a time (setBasePath
 * in mobile-updater.ts), so all three channels live together under
 * `ota/active/`. Each channel's zip only ever contains that channel's own
 * top-level entries (see scripts/split-ota-bundle.js's classification
 * tables), so applying one channel can never touch another channel's
 * files.
 *
 * ── What an update does ──────────────────────────────────────────────────
 * 1. Unzip the new version into a scratch staging directory (native
 *    plugin, with a size check before and an entry-count check after).
 * 2. Write a write-ahead marker.
 * 3. Move the channel's current entries into a backup directory, then the
 *    staged entries into `ota/active/`. These are same-filesystem renames
 *    (stock @capacitor/filesystem), not byte copies.
 * 4. Write the channel's pointer, unconfirmed, then remove the marker.
 *
 * Steps 3-4 are several separate renames, so the app CAN be killed with
 * the channel half swapped. That state is detected by the marker on the
 * next launch and rolled back (or forward, if the pointer had already
 * been written) before anything is served - see ota-core.ts for the
 * mechanics, which are shared with the desktop build.
 *
 * ── Two lifecycles ───────────────────────────────────────────────────────
 * - BOOTSTRAP (no OTA installed yet): all three channel zips are unzipped
 *   into a fresh `ota/active/`. If that version never boots, the whole
 *   thing is discarded and the app's originally-bundled content is served
 *   again.
 * - INCREMENTAL: each channel updates independently as above. A version
 *   that never boots is rolled back to the last CONFIRMED version of that
 *   channel only; the other channels are not touched.
 */

import {
  ACTIVE_DIR,
  CHANNELS,
  type ChannelName,
  type ChannelPointer,
  type OtaFs,
  type UnzipExpectation,
  applyChannelUpdate as coreApplyChannelUpdate,
  bootstrapActive as coreBootstrapActive,
  confirmBootSuccess,
  isOtaBootstrapped as coreIsOtaBootstrapped,
  markLoadReached,
  prepareBoot,
  readChannelPointer as coreReadChannelPointer,
} from "#system/offline/ota-core";

export { CHANNELS };
export type { ChannelName, ChannelPointer, UnzipExpectation };

function cap(): any {
  return typeof window !== "undefined" ? (window as any).Capacitor : undefined;
}

function filesystem(): any {
  return cap()?.Plugins?.Filesystem;
}

function otaUnzip(): any {
  return cap()?.Plugins?.OtaUnzip;
}

function log(message: string): void {
  console.log(`[ota-parts] ${message}`);
}

/** ota-core's filesystem, on top of the stock Capacitor Filesystem plugin (app-private DATA directory) and the OtaUnzip plugin. */
function createCapacitorOtaFs(fs: any, unzip: any): OtaFs {
  const directory = "DATA";
  return {
    async readText(path) {
      try {
        const { data } = await fs.readFile({ path, directory, encoding: "utf8" });
        return typeof data === "string" ? data : null;
      } catch {
        return null;
      }
    },
    async writeText(path, data) {
      await fs.writeFile({ path, data, directory, encoding: "utf8", recursive: true });
    },
    async exists(path) {
      try {
        await fs.stat({ path, directory });
        return true;
      } catch {
        return false;
      }
    },
    async rename(from, to) {
      await fs.rename({ from, to, directory, toDirectory: directory });
    },
    async rmrf(path) {
      let type: string;
      try {
        ({ type } = await fs.stat({ path, directory }));
      } catch {
        return; // already gone
      }
      if (type === "directory") {
        await fs.rmdir({ path, directory, recursive: true });
      } else {
        await fs.deleteFile({ path, directory });
      }
    },
    async mkdirp(path) {
      await fs.mkdir({ path, directory, recursive: true }).catch(() => {});
    },
    async unzip(zipPath, destDir, expect) {
      if (!unzip) {
        throw new Error("Capacitor OtaUnzip plugin not available.");
      }
      const { uri } = await fs.getUri({ path: destDir, directory });
      const options: Record<string, unknown> = { sourcePath: zipPath, destDir: uri };
      if (expect?.bytes !== undefined) {
        options.expectedBytes = expect.bytes;
      }
      if (expect?.entries !== undefined) {
        options.expectedEntries = expect.entries;
      }
      return unzip.unzip(options);
    },
  };
}

function otaFs(): OtaFs | null {
  const fs = filesystem();
  return fs ? createCapacitorOtaFs(fs, otaUnzip()) : null;
}

function requireOtaFs(): OtaFs {
  const fs = otaFs();
  if (!fs || !otaUnzip()) {
    throw new Error("Capacitor Filesystem/OtaUnzip plugin not available.");
  }
  return fs;
}

/** The one directory every channel's files live under, and the path the WebView's base path points at once any OTA is active. */
export async function getActiveDirUri(): Promise<string> {
  const { uri } = await filesystem().getUri({ path: ACTIVE_DIR, directory: "DATA" });
  return uri;
}

/** True once a complete OTA (all three channels) is installed - see the two-lifecycles note above. */
export async function isOtaBootstrapped(): Promise<boolean> {
  const fs = otaFs();
  return fs ? coreIsOtaBootstrapped(fs) : false;
}

export async function readChannelPointer(channel: ChannelName): Promise<ChannelPointer | null> {
  const fs = otaFs();
  return fs ? coreReadChannelPointer(fs, channel) : null;
}

/**
 * Free bytes on the volume holding app data, or null when it can't be
 * determined (callers then skip their free-space check rather than block
 * an update on it). The number never leaves the device.
 */
export async function getFreeBytes(): Promise<number | null> {
  try {
    const result = await otaUnzip()?.freeSpace?.();
    return typeof result?.bytes === "number" && result.bytes >= 0 ? result.bytes : null;
  } catch {
    return null;
  }
}

/**
 * First-ever OTA apply: unzips all three downloaded channel zips into a
 * fresh `ota/active/`, then writes all three pointers unconfirmed.
 */
export async function bootstrapActive(
  channelZipPaths: Record<ChannelName, string>,
  versions: Record<ChannelName, string>,
  expectations: Partial<Record<ChannelName, UnzipExpectation>>,
  shellIdentity: string | null,
): Promise<void> {
  const fs = requireOtaFs();
  await coreBootstrapActive(
    fs,
    async activeDir => {
      for (const channel of CHANNELS) {
        const expect = expectations[channel];
        const { entryCount } = await fs.unzip(channelZipPaths[channel], activeDir, expect);
        if (expect?.entries !== undefined && entryCount !== expect.entries) {
          throw new Error(`OTA ${channel} zip is incomplete: expected ${expect.entries} entries, got ${entryCount}.`);
        }
        log(`bootstrapActive: unzipped ${channel} (${entryCount} entries)`);
      }
    },
    versions,
    { shellIdentity, log },
  );
}

/** Incremental update to ONE channel, once an OTA is already bootstrapped. Leaves the other two channels untouched on disk. */
export async function applyChannelUpdate(channel: ChannelName, zipPath: string, newVersion: string, expect?: UnzipExpectation): Promise<void> {
  await coreApplyChannelUpdate(requireOtaFs(), channel, zipPath, newVersion, { expect, log });
}

/**
 * Boot hook - call once, early, on every cold launch. Finishes or undoes
 * an interrupted update, discards OTA content left over from a different
 * native build, rolls back any channel that has repeatedly failed to
 * confirm, then (if a complete `ota/active/` is left) calls setBasePath
 * exactly once for the whole directory - never once per channel, since
 * both platforms' setServerBasePath forces an immediate WebView reload
 * every call (see mobile-updater.ts's OTA_REAPPLIED_SESSION_KEY comment).
 *
 * Returns whether setBasePath was actually called - the caller's own
 * session guard must only consider a reapply "done" when this is true.
 */
export async function reapplyActivePartsIfAny(setBasePath: (path: string) => Promise<void>, shellIdentity: string | null): Promise<boolean> {
  const fs = otaFs();
  if (!fs) {
    return false;
  }
  if (!(await prepareBoot(fs, { shellIdentity, log }))) {
    return false;
  }
  await setBasePath(await getActiveDirUri());
  return true;
}

/** Records that this launch got as far as running the OTA content's own JS. Call at most once per launch. */
export async function markPartsLoadReached(): Promise<void> {
  const fs = otaFs();
  if (fs) {
    await markLoadReached(fs);
  }
}

/** Call once the title screen is reached. Confirms every unconfirmed channel and clears its now-superseded backup. */
export async function confirmPartsBootSuccess(): Promise<void> {
  const fs = otaFs();
  if (fs) {
    await confirmBootSuccess(fs);
  }
}
