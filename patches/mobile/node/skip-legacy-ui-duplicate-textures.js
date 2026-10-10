#!/usr/bin/env node
/**
 * Patch: skip-legacy-ui-duplicate-textures.js
 *
 * Part of the memory-usage project (see prune-stale-pokemon-assets.js for the
 * other, bigger half). This one fixes a much simpler problem: every single
 * UI image/spritesheet/atlas (~150 files - buttons, windows, icons, etc.) is
 * loaded TWICE at boot, unconditionally, regardless of whether the player
 * has ever turned on the "Legacy" UI theme:
 *
 *   SceneBase.loadImage/loadSpritesheet/loadAtlas (src/scene-base.ts) each
 *   load the requested asset, then - whenever its folder starts with "ui" -
 *   ALSO load a second "<key>_legacy" copy from the "ui/legacy" folder, used
 *   only if the player switches `settings.display.uiTheme` to Legacy at
 *   runtime (src/ui/ui-theme.ts checks `settings.isLegacyTheme` +
 *   `legacyCompatibleImages.includes(texture)` to decide which copy to draw).
 *
 * Legacy theme is an opt-in backward-compat skin, not the default
 * (`UiTheme.DEFAULT`, src/system/settings/default-settings.ts). For every
 * player who hasn't opted into it, this is a flat, pointless doubling of UI
 * texture memory from the moment the game boots.
 *
 * Fix: only queue the "_legacy" load when `settings.isLegacyTheme` is
 * already true. `settings` (src/system/settings/settings-manager.ts) loads
 * synchronously from localStorage in its constructor, well before
 * LoadingScene.preload() runs, so this is safe to check at load time.
 *
 * Category: mobile (not all). Desktop/Electron builds have no memory
 * pressure problem here and no reason to deviate from upstream, so this
 * patch - and the extra `settings.isLegacyTheme` branch - simply doesn't
 * exist in desktop builds at all.
 *
 * KNOWN TRADEOFF: a mobile player who switches UI theme to Legacy mid-
 * session won't see it until they restart the app - the "_legacy" texture
 * simply hasn't been loaded yet, and nothing in this patch adds an on-demand
 * loader for it. Given how rarely this toggle is used, that's judged an
 * acceptable cost for halving baseline UI texture memory on every other
 * mobile player. (Switching BACK to Default theme is unaffected either way,
 * since the non-legacy texture is always loaded.)
 *
 * IMPORTANT - ordering with fix-android-image-paths.js: that patch (android
 * category, always applied after this one - apply-patches.sh always runs
 * mobile before android) does a whole-method-body exact-text replace of
 * loadImage. Its anchors have been resynced in the same commit as this patch
 * to expect the `settings.isLegacyTheme &&` guard this patch adds. If either
 * patch's shape of loadImage changes again later, re-check the other.
 *
 * Targets: pokerogue-src/src/scene-base.ts
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join("pokerogue-src", "src", "scene-base.ts");

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Could not find target file: ${TARGET}`);
  console.error("Make sure this script is run from the repo root.");
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8");

if (src.includes("settings.isLegacyTheme && folder.startsWith(\"ui\")")) {
  console.log("Legacy UI duplicate-texture skip already present, skipping.");
  process.exit(0);
}

// ── Import ────────────────────────────────────────────────────────────────

const IMPORT_ANCHOR = `import { timedEventManager } from "#app/global-event-manager";\n`;
if (!src.includes(IMPORT_ANCHOR)) {
  console.error('ERROR: Could not find anchor for "timedEventManager import in scene-base.ts".');
  console.error("The upstream file may have changed. Manual inspection required.");
  process.exit(1);
}
src = src.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}import { settings } from "#app/global-settings-manager";\n`);

// ── Guard the three "_legacy" duplicate loads ───────────────────────────────
//
// loadImage, loadSpritesheet, and loadAtlas each contain the exact same
// 3-line guard (`if (folder.startsWith("ui")) { ... }`), differing only in
// which `this.load.*` call they wrap. Rather than three near-identical
// anchor blocks, replace every occurrence of the shared condition line in
// one pass, and verify there were exactly three (one per method) so an
// upstream change to this count fails loudly instead of silently patching
// fewer methods than intended.

const CONDITION_ANCHOR = `    if (folder.startsWith("ui")) {`;
const occurrences = src.split(CONDITION_ANCHOR).length - 1;
if (occurrences !== 3) {
  console.error(
    `ERROR: Expected exactly 3 occurrences of the "_legacy" duplicate-load guard in scene-base.ts, found ${occurrences}.`,
  );
  console.error("The upstream file may have changed (loadImage/loadSpritesheet/loadAtlas). Manual inspection required.");
  process.exit(1);
}

src = src.split(CONDITION_ANCHOR).join(
  `    // Offline: skip the Legacy-theme duplicate unless the player has actually\n` +
    `    // opted into Legacy theme (mobile only - see skip-legacy-ui-duplicate-\n` +
    `    // textures.js header for the "switching themes needs a restart" tradeoff).\n` +
    `    if (settings.isLegacyTheme && folder.startsWith("ui")) {`,
);

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched loadImage/loadSpritesheet/loadAtlas in ${TARGET}`);
console.log("Legacy UI duplicate-texture skip applied successfully.");
