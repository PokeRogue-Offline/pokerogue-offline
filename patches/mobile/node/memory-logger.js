#!/usr/bin/env node
/**
 * Patch: memory-logger.js
 *
 * Scooom dev builds only (gated at runtime on isScoomDev, see
 * new-files/src/system/offline/scooom-dev.ts): writes a periodic
 * memory-composition log to Documents/memory-log.txt (iOS: readable in the
 * Files app, no Mac needed) so out-of-memory kills on low-RAM devices (e.g. 4GB
 * iPhones, where WebKit's WebContent process gets jetsammed at roughly
 * 1.7GB) can be attributed to textures/audio/etc. See memory-logger.ts's
 * header for what is and isn't measured.
 *
 * Sub-patches:
 *
 *   0. src/system/offline/memory-logger.ts (new file)
 *
 *   1. src/phases/new-battle-phase.ts
 *        Calls logMemorySnapshot("new-battle") right after the existing
 *        pruneMoveAnimAssets() call, i.e. AFTER this wave's pruning, so each
 *        wave's line shows what survives pruning. Depends on
 *        prune-stale-pokemon-assets.js (scooom-dev.ts, the pruneStaleAssets()
 *        call) and prune-stale-move-anim-assets.js (the pruneMoveAnimAssets()
 *        call) having run first - guaranteed by apply-patches.sh ordering, and
 *        skipped together with them by MEMORY_PATCHES_ENABLED=false.
 *
 * NOTE ON TESTING: confirmed to apply and build against pagefaultgames/pokerogue
 * hotfix-1.12.2.7 (Phaser 4). It has NOT been run on a device.
 *
 * Targets: pokerogue-src/src/phases/new-battle-phase.ts
 *          pokerogue-src/src/system/offline/memory-logger.ts (new file)
 */

const fs = require("fs");
const path = require("path");

function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: Could not find ${filePath}`);
    console.error("Make sure this script is run from the repo root and all submodules are initialised.");
    process.exit(1);
  }
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`  Written: ${filePath}`);
}

function requireAnchor(src, anchor, label) {
  if (!src.includes(anchor)) {
    console.error(`ERROR: Could not find anchor for "${label}".`);
    console.error("The upstream file may have changed (or an earlier memory patch did not run). Manual inspection required.");
    process.exit(1);
  }
}

const NEW_FILES_DIR = path.join(__dirname, "..", "..", "..", "new-files");

// Sub-patch 0: new file
const LOGGER_PATH = path.join("pokerogue-src", "src", "system", "offline", "memory-logger.ts");
if (fs.existsSync(LOGGER_PATH)) {
  console.log("SKIP memory-logger.ts — already exists");
} else {
  writeFile(
    LOGGER_PATH,
    fs.readFileSync(path.join(NEW_FILES_DIR, "src", "system", "offline", "memory-logger.ts"), "utf8"),
  );
}

// Sub-patch 1: hook into NewBattlePhase
const PHASE_PATH = path.join("pokerogue-src", "src", "phases", "new-battle-phase.ts");
let phaseSrc = readFile(PHASE_PATH);

if (phaseSrc.includes("logMemorySnapshot")) {
  console.log("SKIP new-battle-phase.ts — logMemorySnapshot already present");
} else {
  const IMPORT_ANCHOR = `import { BattlePhase } from "#phases/battle-phase";`;
  const CALL_ANCHOR = `    globalScene.pruneMoveAnimAssets();`;
  requireAnchor(phaseSrc, IMPORT_ANCHOR, "BattlePhase import in new-battle-phase.ts");
  requireAnchor(phaseSrc, CALL_ANCHOR, "pruneMoveAnimAssets() call in new-battle-phase.ts");
  phaseSrc = phaseSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\nimport { logMemorySnapshot } from "#system/offline/memory-logger";`,
  );
  phaseSrc = phaseSrc.replace(
    CALL_ANCHOR,
    `${CALL_ANCHOR}\n    // Offline (Scooom dev builds only): record what survived this wave's pruning.\n    logMemorySnapshot("new-battle");`,
  );
  writeFile(PHASE_PATH, phaseSrc);
}

console.log("Memory logger applied successfully.");
