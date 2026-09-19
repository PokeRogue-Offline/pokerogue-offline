#!/usr/bin/env node
/**
 * Patch: auto-drive-sync.js
 *
 * Adds an automatic Google Drive upload attempt every 5 waves, matching the
 * online game's own server-checkpoint cadence (`waveIndex % 5 === 1` — see
 * the "Game syncs to server on waves X1 and X6" comment this patch anchors
 * on). Calls the new #system/offline/google-drive-backup.ts export
 * autoSyncCheckpoint(), which is itself gated by a dirty flag, a debounce
 * interval, and an anti-overwrite safety check against Drive's own revision
 * fingerprint — see that module's doc-comment for the full design. This
 * patch's own job is intentionally tiny: fire the checkpoint at the right
 * moment, fire-and-forget, and nothing else.
 *
 * Only fires on a successful local save (inside the existing `if (!success)`
 * early-return's else-branch) — a failed local save must never trigger a
 * Drive attempt. Deliberately does NOT also key off the online game's
 * `lastSavePlayTime >= 300` long-wave fallback (that governs its own
 * server-sync cadence, not ours) — auto-sync here uses a fixed 5-wave
 * cadence with its own independent debounce, per the anti-overwrite design.
 *
 * Depends on app-settings-menu.js having already run (needs
 * google-drive-backup.ts already copied into pokerogue-src, since this patch
 * imports from it). Must be applied after app-settings-menu.js.
 *
 * Targets: pokerogue-src/src/phases/encounter-phase.ts
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
    console.error("The upstream file may have changed. Manual inspection required.");
    process.exit(1);
  }
}

const TARGET = path.join("pokerogue-src", "src", "phases", "encounter-phase.ts");

let src = readFile(TARGET);

if (src.includes("autoSyncCheckpoint")) {
  console.log("Auto Drive sync checkpoint already present, skipping.");
  process.exit(0);
}

// ── Sub-patch 1: new import, alongside the existing #system/achv import ────

const IMPORT_ANCHOR = `import { achvs } from "#system/achv";\n`;
requireAnchor(src, IMPORT_ANCHOR, '\'import { achvs } from "#system/achv";\' in encounter-phase.ts');
src = src.replace(
  IMPORT_ANCHOR,
  `${IMPORT_ANCHOR}import { autoSyncCheckpoint } from "#system/offline/google-drive-backup";\n`,
);

// ── Sub-patch 2: fire the checkpoint right after a successful checkpoint-wave local save ──

const SAVE_ANCHOR =
  `          globalScene.gameData\n` +
  `            .saveAll(true, battle.waveIndex % 5 === 1 || (globalScene.lastSavePlayTime ?? 0) >= 300)\n` +
  `            .then(success => {\n` +
  `              globalScene.disableMenu = false;\n` +
  `              if (!success) {\n` +
  `                return globalScene.reset(true);\n` +
  `              }\n` +
  `              this.doEncounter();\n` +
  `              globalScene.resetSeed();\n` +
  `            });`;
requireAnchor(src, SAVE_ANCHOR, "wave-checkpoint saveAll(...).then(success => {...}) block in encounter-phase.ts");
src = src.replace(
  SAVE_ANCHOR,
  `          globalScene.gameData\n` +
    `            .saveAll(true, battle.waveIndex % 5 === 1 || (globalScene.lastSavePlayTime ?? 0) >= 300)\n` +
    `            .then(success => {\n` +
    `              globalScene.disableMenu = false;\n` +
    `              if (!success) {\n` +
    `                return globalScene.reset(true);\n` +
    `              }\n` +
    `              // auto-drive-sync: attempt an auto-upload on the same 5-wave\n` +
    `              // cadence the online game itself checkpoints on. Fire-and-forget —\n` +
    `              // autoSyncCheckpoint() never throws and must never block gameplay.\n` +
    `              if (battle.waveIndex % 5 === 1) {\n` +
    `                void autoSyncCheckpoint();\n` +
    `              }\n` +
    `              this.doEncounter();\n` +
    `              globalScene.resetSeed();\n` +
    `            });`,
);

writeFile(TARGET, src);
console.log("Auto Drive sync checkpoint applied successfully.");
