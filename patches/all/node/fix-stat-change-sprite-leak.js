#!/usr/bin/env node
/**
 * Patch: fix-stat-change-sprite-leak.js
 *
 * Upstream bug: StatStageChangePhase.playStatChangeAnimation() (src/phases/
 * stat-stage-change-phase.ts) creates a TileSprite for the stat-change arrow
 * overlay on every single stat change and fades it out, but never destroys
 * it. Each one backs a ~7MB canvas (Phaser's CanvasPool), so canvas memory
 * grows without bound across a run - reported in issue #11 as 69MB -> 540MB
 * over ~40 waves, the main driver of a WebView OOM crash on a 32-bit Android
 * device. The same unbounded growth plausibly also feeds the long-standing
 * "self reload" white-screen crashes iOS Safari/WKWebView players report on
 * long runs (pagefaultgames/pokerogue#3526) - WKWebView's memory budget is
 * tighter than Android's, so it would get hit sooner, not avoided.
 *
 * Upstream fix: pagefaultgames/pokerogue#7819 (statSprite.destroy() after
 * the fade-out). Closed without merging - deferred to the in-progress
 * Phaser 4 upgrade to avoid merge conflicts, with no ETA. This patch applies
 * the same one-line fix directly so players aren't stuck leaking memory
 * until that rewrite lands.
 *
 * Remove once upstream's Phaser 4 rewrite ships the fix: comment out (or
 * delete) this patch's apply_patch line in scripts/apply-patches.sh - no
 * other changes needed.
 *
 * Targets: pokerogue-src/src/phases/stat-stage-change-phase.ts
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join("pokerogue-src", "src", "phases", "stat-stage-change-phase.ts");

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Could not find target file: ${TARGET}`);
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");

if (src.includes("fix-stat-change-sprite-leak")) {
  console.log("fix-stat-change-sprite-leak already applied, skipping.");
  process.exit(0);
}

const ANCHOR = `    await playTween({
      targets: statSprite,
      duration: 250,
      alpha: 0,
    });

    pokemon.disableMask();`;

if (!src.includes(ANCHOR)) {
  console.error("ERROR: Could not find the stat-change fade-out block in stat-stage-change-phase.ts.");
  process.exit(1);
}

const REPLACEMENT = `    await playTween({
      targets: statSprite,
      duration: 250,
      alpha: 0,
    });

    // fix-stat-change-sprite-leak: upstream never frees this TileSprite's
    // backing canvas (pagefaultgames/pokerogue#7819, not yet merged).
    statSprite.destroy();

    pokemon.disableMask();`;

src = src.replace(ANCHOR, REPLACEMENT);

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched stat-change sprite leak in ${TARGET}`);
