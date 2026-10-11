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
 * Fix: only queue the "_legacy" load when the persisted UI theme is already
 * Legacy.
 *
 * v2 - CRASH FIX: v1 of this patch read `settings.isLegacyTheme` (the
 * `settings` singleton exported from src/globals/global-settings-manager.ts).
 * That singleton is declared `export let settings: GlobalSettingsManager`
 * (i.e. undefined until assigned) and is only assigned inside the async
 * `initSettingsManager()`, which src/loading-scene.ts's preload() doesn't
 * call until the very END of preload() (`initializeGame()` at the bottom of
 * the method, src/loading-scene.ts:371) - AFTER every loadImage/
 * loadSpritesheet/loadAtlas call earlier in that same preload() has already
 * run. `settings` is therefore still `undefined` at the exact point this
 * patch's guard runs, and `settings.isLegacyTheme` threw a synchronous
 * TypeError on the very first "ui"-folder load (`loadAtlas("bg", "ui")`,
 * loading-scene.ts's preload() line ~39) - aborting the whole chained
 * preload() call before any assets queued and before initializeGame() ever
 * ran, producing a black screen with no console output (confirmed via
 * manual device testing: iOS build hung on a solid black screen, zero
 * Network requests captured, zero console errors - consistent with a crash
 * early enough that the remote debugger hadn't attached yet). Other files
 * that read `settings.isLegacyTheme` (src/ui/ui-theme.ts, src/ui/text.ts,
 * src/touch-controls.ts) are all safe because they only run during UI
 * rendering, well after initializeGame() has resolved - this patch's bug was
 * specifically about running during the *asset-queueing* phase of preload(),
 * before that.
 *
 * v2 fix: read the persisted UI theme directly out of localStorage instead
 * of through the `settings` singleton, bypassing the readiness problem
 * entirely. Mirrors SettingsManager.loadFromLocalStorage()'s key ("settings"
 * - see src/utils/data.ts's getDataTypeKey(GameDataType.SETTINGS), not
 * imported here to avoid pulling scene-base.ts, which loads very early, into
 * a heavier/riskier dependency graph for one stable string literal) and
 * shape (`display.uiTheme`), defaulting to false (not Legacy) on any missing
 * data or parse failure, same as SettingsManager's own defaults.
 *
 * Category: mobile (not all). Desktop/Electron builds have no memory
 * pressure problem here and no reason to deviate from upstream, so this
 * patch simply doesn't exist in desktop builds at all.
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
 * to expect the `isLegacyThemeStored() &&` guard this patch adds. If either
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

if (src.includes("isLegacyThemeStored()")) {
  console.log("Legacy UI duplicate-texture skip already present, skipping.");
  process.exit(0);
}

// ── Import + helper ──────────────────────────────────────────────────────

const IMPORT_ANCHOR = `import { timedEventManager } from "#app/global-event-manager";\n`;
if (!src.includes(IMPORT_ANCHOR)) {
  console.error('ERROR: Could not find anchor for "timedEventManager import in scene-base.ts".');
  console.error("The upstream file may have changed. Manual inspection required.");
  process.exit(1);
}
src = src.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}import { UiTheme } from "#enums/ui-theme";\n`);

const CLASS_ANCHOR = `export class SceneBase extends Phaser.Scene {`;
if (!src.includes(CLASS_ANCHOR)) {
  console.error('ERROR: Could not find anchor for "SceneBase class declaration in scene-base.ts".');
  console.error("The upstream file may have changed. Manual inspection required.");
  process.exit(1);
}
src = src.replace(
  CLASS_ANCHOR,
  `/**\n` +
    ` * Offline: reads the persisted UI theme directly out of localStorage,\n` +
    ` * bypassing the \`settings\` singleton (src/globals/global-settings-manager.ts)\n` +
    ` * - which is still \`undefined\` here, since SceneBase.loadImage/\n` +
    ` * loadSpritesheet/loadAtlas run during LoadingScene.preload(), and that\n` +
    ` * singleton isn't assigned until initializeGame() runs at the very end of\n` +
    ` * that same preload() (see this patch's header comment for the crash this\n` +
    ` * caused before this indirection was added). Mirrors\n` +
    ` * SettingsManager.loadFromLocalStorage()'s key/shape; defaults to false on\n` +
    ` * any missing data or parse failure, same as SettingsManager's own default.\n` +
    ` */\n` +
    `function isLegacyThemeStored(): boolean {\n` +
    `  try {\n` +
    `    const stored = localStorage.getItem("settings");\n` +
    `    if (!stored) {\n` +
    `      return false;\n` +
    `    }\n` +
    `    return JSON.parse(stored)?.display?.uiTheme === UiTheme.LEGACY;\n` +
    `  } catch {\n` +
    `    return false;\n` +
    `  }\n` +
    `}\n` +
    `\n` +
    `${CLASS_ANCHOR}`,
);

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
    `    // textures.js header for the "switching themes needs a restart" tradeoff,\n` +
    `    // and why this reads localStorage directly instead of \`settings\`).\n` +
    `    if (isLegacyThemeStored() && folder.startsWith("ui")) {`,
);

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched loadImage/loadSpritesheet/loadAtlas in ${TARGET}`);
console.log("Legacy UI duplicate-texture skip applied successfully.");
