#!/usr/bin/env node
/**
 * split-ota-bundle.js <android|ios> <distDir> <outDir> <version> <buildNumber> <nativeFingerprint> <channel>
 *
 * Replaces the old single `zip -r ota-<platform>.zip dist` + hand-written
 * manifest steps in build-android.yml/build-ios.yml. Splits the built
 * `dist/` into three independently-updatable channels - code, assets,
 * locales - and writes a v2 manifest describing all three, so
 * mobile-updater.ts can download/stage/activate only the channel(s) that
 * actually changed since the installed build, instead of always
 * re-shipping the whole bundle (assets alone are hundreds of MB; code is a
 * few MB). See the "Split mobile OTA updates" plan for the full rationale
 * and the real release-history data behind it.
 *
 * Classification is by TOP-LEVEL dist/ entry name only, via the explicit
 * tables below - never by walking into a directory's own contents. This
 * matters because Vite's own hashed JS/CSS chunk directory is also named
 * `assets/` (no relation to the game-assets concept this script cares
 * about) - distinguishing "assets channel" from "Vite's assets/ dir" by
 * anything other than "is this exact top-level name in ASSET_ENTRIES"
 * would be fragile. Any top-level entry not found in ANY of the three
 * tables fails the build loudly (see classify() below) rather than being
 * silently misrouted - a new upstream top-level file/directory must be a
 * conscious addition to one of these tables, not a guess.
 *
 * Each channel's zip wraps its content in one synthetic top-level
 * directory (code/, assets/, locales/) - matching the existing
 * `zip -r ota.zip dist` convention the native OtaUnzip plugin's
 * stripLeadingSegment() already expects (strips exactly one leading path
 * segment per entry). This means the native unzip side needs NO changes
 * at all to support the three-way split.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// Top-level dist/ entries that ship from the `assets` submodule
// (pokerogue-assets), copied in by upstream's vite-minify-json-plugin.ts -
// confirmed against that submodule's actual root contents, not guessed
// from generic Vite conventions. `service-worker.js` ALSO ships from that
// submodule physically, but is deliberately classified as CODE below
// instead (see CODE_ENTRIES) - it controls caching/update behavior, so a
// fix to it should ship at code's cadence, not wait for the next asset
// bump. This is a judgment call, not a fact pulled from the submodule.
const ASSET_ENTRIES = [
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
];

// The locales submodule (pokerogue-locales) lands at dist/locales/ with no
// ambiguity - upstream's vite-minify-json-plugin.ts copies it there
// directly, under its own name, with no ambiguity as to what it is.
const LOCALE_ENTRIES = ["locales"];

// Everything that is Vite's own build output, or otherwise code-adjacent.
// `assets` here is Vite's hashed JS/CSS chunk directory (NOT the game
// `assets` submodule content - see the classification note above).
const CODE_ENTRIES = ["index.html", "assets", "service-worker.js", "favicon.ico", "robots.txt"];

const CHANNELS = {
  code: CODE_ENTRIES,
  assets: ASSET_ENTRIES,
  locales: LOCALE_ENTRIES,
};

function channelForEntry(entryName) {
  for (const [channel, entries] of Object.entries(CHANNELS)) {
    if (entries.includes(entryName)) {
      return channel;
    }
  }
  return null;
}

/**
 * Copies `srcDir`'s classified top-level entries into per-channel
 * staging directories under `stagingRoot` (stagingRoot/code/..,
 * stagingRoot/assets/.., stagingRoot/locales/..), mirroring each entry's
 * relative position. Fails loudly (see channelForEntry above) on any
 * top-level entry this script doesn't recognize, instead of silently
 * shipping it in the wrong channel or dropping it.
 */
function classifyAndStage(distDir, stagingRoot) {
  const topLevelEntries = fs.readdirSync(distDir);
  const unclassified = [];

  for (const channel of Object.keys(CHANNELS)) {
    fs.mkdirSync(path.join(stagingRoot, channel), { recursive: true });
  }

  for (const entryName of topLevelEntries) {
    const channel = channelForEntry(entryName);
    if (!channel) {
      unclassified.push(entryName);
      continue;
    }
    fs.cpSync(path.join(distDir, entryName), path.join(stagingRoot, channel, entryName), { recursive: true });
  }

  if (unclassified.length > 0) {
    console.error(
      `ERROR: split-ota-bundle.js found dist/ top-level entries not in ANY classification table: ${unclassified.join(", ")}\n` +
        `This is a deliberate fail-loud guard (see this script's header comment) - add the new entry to ASSET_ENTRIES, ` +
        `LOCALE_ENTRIES, or CODE_ENTRIES in scripts/split-ota-bundle.js, as a conscious decision about which channel it ` +
        `belongs to, rather than letting it default silently into the wrong one.`,
    );
    process.exit(1);
  }
}

/**
 * Deterministic content hash for one channel's staged directory - over
 * sorted (relative path, file bytes) pairs, NOT the zip's own bytes. A zip
 * file's bytes vary run-to-run (mtimes, compression-library version) even
 * when its content is byte-for-byte identical, which would make a
 * zip-based hash falsely report "changed" on every rebuild of genuinely
 * unchanged content - exactly the false-positive this channel version
 * exists to avoid triggering.
 */
function hashDirectoryContents(dirPath) {
  const hash = crypto.createHash("sha256");
  const relPaths = [];

  function walk(current, relPrefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else {
        relPaths.push(rel);
      }
    }
  }
  walk(dirPath, "");
  relPaths.sort();

  for (const rel of relPaths) {
    hash.update(rel);
    hash.update("\n");
    hash.update(fs.readFileSync(path.join(dirPath, rel)));
    hash.update("\n");
  }

  return hash.digest("hex");
}

function zipChannel(stagingRoot, channel, outPath) {
  // Mirrors the existing `zip -r ota-<platform>.zip dist` convention: zips
  // the channel's own synthetic top-level directory (code/assets/locales),
  // relative to stagingRoot as cwd, so the archive's entries are all
  // prefixed with exactly one segment - same assumption the native
  // OtaUnzip plugin's stripLeadingSegment() already makes, no changes
  // needed there.
  execFileSync("zip", ["-r", "-X", outPath, channel], { cwd: stagingRoot, stdio: "inherit" });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  let [platform, distDir, outDir, version, buildNumberStr, nativeFingerprint, channelFlag] = process.argv.slice(2);

  if (!platform || !distDir || !outDir || !version || !buildNumberStr || !nativeFingerprint || !channelFlag) {
    console.error(
      "Usage: node split-ota-bundle.js <android|ios> <distDir> <outDir> <version> <buildNumber> <nativeFingerprint> <stable|dev>",
    );
    process.exit(1);
  }
  if (platform !== "android" && platform !== "ios") {
    console.error(`Unknown platform "${platform}" - expected "android" or "ios".`);
    process.exit(1);
  }
  if (channelFlag !== "stable" && channelFlag !== "dev") {
    console.error(`Unknown channel "${channelFlag}" - expected "stable" or "dev".`);
    process.exit(1);
  }

  const buildNumber = Number.parseInt(buildNumberStr, 10);
  if (!Number.isInteger(buildNumber)) {
    console.error(`buildNumber must be an integer, got "${buildNumberStr}".`);
    process.exit(1);
  }

  // Resolved to absolute up front - zipChannel() below runs `zip` with
  // stagingRoot as cwd (required so archive entries come out relative,
  // single-segment-prefixed - see zipChannel()'s comment), which would
  // silently resolve a relative outPath against the WRONG directory
  // otherwise.
  distDir = path.resolve(distDir);
  outDir = path.resolve(outDir);

  fs.mkdirSync(outDir, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-split-"));

  console.error(`[split-ota-bundle] classifying ${distDir} into code/assets/locales under ${stagingRoot}`);
  classifyAndStage(distDir, stagingRoot);

  const manifest = {
    schemaVersion: 2,
    version,
    buildNumber,
    nativeFingerprint,
    channel: channelFlag,
  };

  for (const channel of Object.keys(CHANNELS)) {
    const channelVersion = hashDirectoryContents(path.join(stagingRoot, channel));
    const zipName = `ota-${channel}.zip`;
    const zipPath = path.join(outDir, zipName);
    console.error(`[split-ota-bundle] ${channel}: content version ${channelVersion}, zipping to ${zipPath}`);
    zipChannel(stagingRoot, channel, zipPath);
    manifest[channel] = {
      version: channelVersion,
      sha256: sha256File(zipPath),
      assetName: zipName,
    };
  }

  const manifestPath = path.join(outDir, `ota-manifest-${platform}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`[split-ota-bundle] wrote ${manifestPath}:`);
  console.error(JSON.stringify(manifest, null, 2));

  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

main();
