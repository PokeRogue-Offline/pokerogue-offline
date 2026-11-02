#!/usr/bin/env node
/**
 * Patch: prune-stale-pokemon-assets.js
 *
 * Part of the memory-usage project (see skip-legacy-ui-duplicate-textures.js
 * for the other, smaller half). This is the core of it: PokeRogue never
 * frees a Pokemon sprite texture or cry audio buffer once loaded. Every
 * distinct species/form/shiny/variant the player sees - theirs or an
 * opponent's - accumulates in the Phaser texture/audio cache for the rest
 * of the browser tab's lifetime, since nothing ever calls `location.reload()`
 * between runs. Over a long session this grows without bound, which is a
 * real contributor to mobile browsers/WebViews force-reloading the tab under
 * memory pressure (the problem this whole patch set targets).
 *
 * The upstream codebase already has exactly the right building block for
 * fixing this - `BattleScene.getActiveKeys()` (src/battle-scene.ts), which
 * computes the sprite/battle-sprite/cry keys for every Pokemon currently on
 * the field (player party + enemy party, current wave). Its doc comment
 * ("Note: Questions on garbage collection go to `@frutescens`") makes clear
 * the team is aware assets need cleaning up - but today it's wired into
 * exactly one place, the egg-hatch summary screen
 * (src/ui/handlers/egg-summary-ui-handler.ts), not the general battle
 * lifecycle. `BattleScene.clearBiomeAssets()` is the only other eviction
 * code in the codebase, and it only ever touches biome background art.
 *
 * This patch wires the same idea into every wave transition:
 *
 *   1. src/battle-scene.ts
 *        Two new tracking Sets (`trackedPokemonSpriteKeys`,
 *        `trackedPokemonCryKeys`) record every key this client has lazily
 *        loaded for a Pokemon - sprite keys inside the existing
 *        `loadPokemonAtlas()` (src/battle-scene.ts:353, the single choke
 *        point every Pokemon sprite load already goes through - base
 *        species, player battle sprite, and fusion battle sprite all call
 *        it), cry keys via a new `trackPokemonCryKey()` wrapper called from
 *        pokemon-species.ts (sub-patch 2, cries' own single choke point).
 *        A new `pruneStaleAssets()` removes any tracked key that
 *        `getActiveKeys()` no longer protects, mirroring the exact
 *        remove-anim-then-remove-texture pattern `clearBiomeAssets()`
 *        already uses, and the `cache.audio.remove()` call
 *        egg-summary-ui-handler.ts already uses for cries.
 *
 *   2. src/data/pokemon-species.ts
 *        One line in loadAssets(), right after queuing the cry's audio
 *        load, registers that key with trackPokemonCryKey().
 *
 *   3. src/phases/new-battle-phase.ts
 *        Calls `globalScene.pruneStaleAssets()` right after
 *        `globalScene.newBattle()`. By this point getActiveKeys() already
 *        reflects the *new* wave's combatants, so only the *previous*
 *        wave's now-irrelevant sprites/cries get freed - current party
 *        members (who persist across waves) are always protected because
 *        getActiveKeys() walks the whole party, not just the current field.
 *
 * SAFETY: evicting a key is not introducing a new failure mode - every code
 * path that displays a Pokemon sprite already calls loadAssets()/
 * loadPokemonAtlas() and awaits completion before playing the animation
 * (verified in src/ui/handlers/pokedex-ui-handler.ts and
 * pokedex-page-ui-handler.ts, which do exactly this for species browsed in
 * the Pokedex that are NOT on the current field - proving the "re-request an
 * evicted/never-loaded key on demand" path is already a normal, exercised
 * part of the codebase, not something this patch invents). The one residual
 * risk category is a one-off asset load that bypasses this pattern (e.g. a
 * Mystery Encounter preview sprite) - not exhaustively auditable from
 * reading code alone, which is exactly why sub-patch 4 below adds a kill
 * switch.
 *
 *   4. Depends on app-settings-menu.js (v12) having already run - that
 *      patch's own sub-patch 6 (OfflineSettings type/defaults/UI items) was
 *      extended with one new boolean field, "aggressiveMemorySaving"
 *      (default true), surfaced as an "Aggressive Memory Saving" toggle in
 *      the existing Offline -> Preferences screen. pruneStaleAssets() is a
 *      complete no-op when this is off, so the feature can be disabled
 *      instantly from in-game settings without a new build if something
 *      ever looks wrong. apply-patches.sh must run this patch after
 *      app-settings-menu.js (already the case - see apply-patches.sh).
 *
 * NOTE ON TESTING: anchors checked against a fresh clone of
 * pagefaultgames/pokerogue (beta branch) and confirmed to build
 * (`pnpm build --mode app`). The runtime eviction behavior itself (does a
 * long real play session ever show a missing sprite/cry) has NOT been
 * verified in an actual running build - see this repo's manual-testing
 * notes for what to check (long run across several biomes/waves with the
 * setting on, toggle off mid-run, and specifically poke at a few Mystery
 * Encounters with preview sprites).
 *
 * v2 - added temporary diagnostic logging to help debug a real-device report
 * of forced reloads still happening with this feature on. Each individual
 * removal is now wrapped in try/catch (runs in every build, unconditionally
 * - a real safety improvement, not just diagnostics) so an unexpected
 * failure is skipped instead of crashing the whole prune pass.
 *
 * The logging itself is gated on a dedicated `isScoomDev` flag
 * (src/system/offline/scooom-dev.ts, a new file this patch copies in - sub-
 * patch 0 below), NOT upstream's own `isDev`. Upstream's `isDev` is true
 * only when `import.meta.env.MODE === "development"`, but every build this
 * fork actually ships - regular releases, the "-dev" OAuth/app-id flavor,
 * AND nightly - all run `pnpm build --mode app` (checked build-android.yml/
 * build-ios.yml/build-exe.yml/build-appimage.yml/build-macos.yml - the `dev`
 * workflow input only swaps OAuth config/icon/app id/package id, never the
 * Vite mode), so upstream's `isDev` is never true in anything distributed,
 * and gating on it would mean this logging could never be turned on without
 * a one-off custom build. `isScoomDev` is a separate, fork-only flag that
 * each build workflow's new "Inject Scooom dev-build flag" step flips to
 * `true` specifically when `inputs.dev == 'true'` (i.e. nightly and
 * manually-triggered dev-flavor builds) - so it's on exactly for "a Scooom
 * dev build" and nothing else, without also enabling any of upstream's own
 * ~40 isDev-gated behaviors (debug menus, dexForDevs, AI overrides, etc.)
 * that a dev-flavor build was never meant to also turn on.
 *
 * When `isScoomDev` is true, each pruneStaleAssets() call both console.logs
 * AND appends a line (capped to the last 200) to a localStorage key,
 * 'offline_memoryPatchLog' - because the crash/reload this is meant to help
 * diagnose may itself kill the WebView process before anyone's watching the
 * live console, and (unlike console output) localStorage survives that.
 * After a crash, reconnect (e.g. via a remote WebView inspector) and read it
 * back with:
 *
 *   JSON.parse(localStorage.getItem('offline_memoryPatchLog') || '[]').join('\n')
 *
 * Each line includes the wave number, so the log can be correlated with
 * "which wave did it actually crash on" even across a reload.
 *
 * v3 - fixes a real freeze reported in GitHub issue #10: getActiveKeys()
 * only covers the current player+enemy party, so a Pokemon that's on screen
 * but NOT yet a party member (e.g. one that just hatched from an egg - see
 * data/egg.ts's generatePlayerPokemon(), which never pushes it into the
 * actual party array) could have its sprite texture freed by
 * pruneStaleAssets() while the egg-hatch UI (src/phases/egg-hatch-phase.ts,
 * src/ui/containers/pokemon-hatch-info-container.ts) was still rendering it,
 * crashing Phaser's render loop (SpritePipeline.onBind /
 * FieldSpritePipeline.batchSprite reading a texture whose source array was
 * just emptied) and freezing the game with no further frames drawn.
 *
 * Fix: a new `getInUseTextureKeys()` walks the live scene graph
 * (`this.children.list`, recursing through Containers - including Pokemon/
 * Trainer/MysteryEncounterIntroVisuals, which are Containers themselves) to
 * find every texture key actually rendered by something on screen right
 * now, and pruneStaleAssets() additionally protects any key in that set.
 * This generalizes to every current and future UI surface that can show a
 * non-party Pokemon sprite (Pokedex, Starter Select, Mystery Encounter
 * previews, etc.) without needing to special-case each one.
 *
 * The exact same gap existed in the pre-existing (unpatched)
 * `clearBiomeAssets()` - a hardcoded key list freed with no check that
 * `arenaBg`/`arenaPlayer`/`arenaEnemy` had actually released the key - so
 * sub-patch 1e reuses `getInUseTextureKeys()` there too.
 *
 * Sub-patch 4 adds a defensive guard in the sprite render path itself as a
 * safety net: if a texture is ever evicted while still referenced despite
 * the scene-graph check above (e.g. a GameObject not yet attached to the
 * tree mid-transition), the sprite is skipped/hidden for that frame instead
 * of throwing and killing the render loop.
 *
 * v4 - PHASER 4 PORT (2026-10-30): upstream PR #7738 renamed
 * src/pipelines/{sprite,field-sprite}.ts to src/render-nodes/{sprite,
 * field-sprite}.ts and replaced the Pipeline onBind()/onBatch() hooks
 * sub-patches 4/5 used to guard with a Submitter/BatchHandler pair. Verified
 * the hazard itself is unchanged under Phaser 4 (TextureManager.remove() -
 * Texture.destroy() still nulls every Frame.source/texture it owns without
 * walking the scene graph to clear GameObjects still holding a reference,
 * and GameObject.willRender() never checks texture validity), so this guard
 * is still needed, not obsoleted by the rewrite.
 *
 * The port is NOT a 1:1 rename of the old onBind guard into
 * setRenderOptions() (the method that looks like onBind's equivalent).
 * Phaser's own `SubmitterQuad.run()` calls `texturerNode.run()`, then this
 * node's `setRenderOptions()`, then unconditionally reads
 * `texturerNode.frame.source.glTexture` to pass to the batch handler -
 * `run()` never checks setRenderOptions()'s return value, so a guard placed
 * only inside setRenderOptions() can't prevent the crash; execution falls
 * through to the crashing read regardless. The guard has to override
 * `run()` itself, before `super.run()` is called at all.
 *
 * It only needs to be added once, on the base `FieldSpriteSubmitter` (in
 * field-sprite.ts) rather than duplicated onto `SpriteSubmitter` too:
 * `SpriteSubmitter` (Pokemon sprites) extends `FieldSpriteSubmitter` and
 * doesn't override `run()`, and `addFieldSprite()` (arenaBg/arenaPlayer/
 * arenaEnemy/trainer - what clearBiomeAssets() evicts) goes through
 * `FieldSpriteSubmitter` directly - so one override on the base class
 * protects both call sites via inheritance. This also means sub-patch 5
 * (the old separate field-sprite.ts pipeline guard) no longer exists as a
 * separate step; it's folded into sub-patch 4.
 *
 * Targets: pokerogue-src/src/battle-scene.ts
 *          pokerogue-src/src/data/pokemon-species.ts
 *          pokerogue-src/src/phases/new-battle-phase.ts
 *          pokerogue-src/src/render-nodes/field-sprite.ts
 *          pokerogue-src/src/system/offline/scooom-dev.ts (new file)
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

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 0: src/system/offline/scooom-dev.ts (new file)
// ─────────────────────────────────────────────────────────────────────────────

const NEW_FILES_DIR = path.join(__dirname, "..", "..", "..", "new-files");
const SCOOOM_DEV_PATH = path.join("pokerogue-src", "src", "system", "offline", "scooom-dev.ts");

if (fs.existsSync(SCOOOM_DEV_PATH)) {
  console.log("SKIP scooom-dev.ts — already exists");
} else {
  const scooomDevSrc = fs.readFileSync(
    path.join(NEW_FILES_DIR, "src", "system", "offline", "scooom-dev.ts"),
    "utf8",
  );
  writeFile(SCOOOM_DEV_PATH, scooomDevSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1: src/battle-scene.ts
// ─────────────────────────────────────────────────────────────────────────────

const BATTLE_SCENE_PATH = path.join("pokerogue-src", "src", "battle-scene.ts");
let battleSceneSrc = readFile(BATTLE_SCENE_PATH);

if (battleSceneSrc.includes("pruneStaleAssets")) {
  console.log("SKIP battle-scene.ts — pruneStaleAssets already present");
} else {
  // 1a. Import isScoomDev (used by pruneStaleAssets() below - see this
  // patch's header comment ("v2") for the isScoomDev vs. isDev reasoning).
  const BATTLE_IMPORT_ANCHOR = `import { Battle } from "#app/battle";\n`;
  requireAnchor(battleSceneSrc, BATTLE_IMPORT_ANCHOR, "Battle import in battle-scene.ts");
  battleSceneSrc = battleSceneSrc.replace(
    BATTLE_IMPORT_ANCHOR,
    `${BATTLE_IMPORT_ANCHOR}import { isScoomDev } from "#system/offline/scooom-dev";\n`,
  );

  // 1b. Module-scope helper backing pruneStaleAssets()'s diagnostic logging.
  // Inserted right before the class declaration (module scope, not a class
  // member).
  const CLASS_DECL_ANCHOR = `// TODO: Breakup into multiple scenes if possible/practical\nexport class BattleScene extends SceneBase {`;
  requireAnchor(battleSceneSrc, CLASS_DECL_ANCHOR, "BattleScene class declaration in battle-scene.ts");
  battleSceneSrc = battleSceneSrc.replace(
    CLASS_DECL_ANCHOR,
    `/** Offline: appends one line (capped to the last 200) to the persisted memory-patch debug log. */\n` +
      `function appendMemoryDebugLog(line: string): void {\n` +
      `  try {\n` +
      `    const key = "offline_memoryPatchLog";\n` +
      `    const log: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");\n` +
      `    log.push(\`\${new Date().toISOString()} \${line}\`);\n` +
      `    while (log.length > 200) {\n` +
      `      log.shift();\n` +
      `    }\n` +
      `    localStorage.setItem(key, JSON.stringify(log));\n` +
      `  } catch {\n` +
      `    // best-effort only - never let logging itself break anything\n` +
      `  }\n` +
      `}\n` +
      `\n` +
      `${CLASS_DECL_ANCHOR}`,
  );

  // 1c. Register every sprite atlas key the moment it's queued for load -
  // loadPokemonAtlas() is the single choke point all Pokemon sprite loads
  // (base species, player battle sprite, fusion battle sprite) go through.
  const LOAD_ATLAS_ANCHOR =
    `  public loadPokemonAtlas(key: string, atlasPath: string, experimental = settings.expSpritesEnabled): void {\n` +
    `    const variant = atlasPath.includes("variant/") || /_[0-3]$/.test(atlasPath);`;
  requireAnchor(battleSceneSrc, LOAD_ATLAS_ANCHOR, "loadPokemonAtlas() signature in battle-scene.ts");
  battleSceneSrc = battleSceneSrc.replace(
    LOAD_ATLAS_ANCHOR,
    `  public loadPokemonAtlas(key: string, atlasPath: string, experimental = settings.expSpritesEnabled): void {\n` +
      `    // Offline: track every sprite key we load so pruneStaleAssets() can later\n` +
      `    // free it once no active Pokemon references it (see that method).\n` +
      `    this.trackedPokemonSpriteKeys.add(key);\n` +
      `    const variant = atlasPath.includes("variant/") || /_[0-3]$/.test(atlasPath);`,
  );

  // 1d. New tracking Sets + trackPokemonCryKey() + pruneStaleAssets(), right
  // before the existing getActiveKeys() - the method they build on.
  const ACTIVE_KEYS_ANCHOR =
    `  /**\n` +
    `   * This function retrieves the sprite and audio keys for active Pokemon.\n` +
    `   * Active Pokemon include both enemy and player Pokemon of the current wave.\n` +
    `   * Note: Questions on garbage collection go to \`@frutescens\`\n` +
    `   * @returns a string array of active sprite and audio keys that should not be deleted\n` +
    `   */\n` +
    `  getActiveKeys(): string[] {`;
  requireAnchor(battleSceneSrc, ACTIVE_KEYS_ANCHOR, "getActiveKeys() doc comment + signature in battle-scene.ts");
  battleSceneSrc = battleSceneSrc.replace(
    ACTIVE_KEYS_ANCHOR,
    `  /**\n` +
      `   * Offline: sprite atlas keys registered via loadPokemonAtlas() and cry audio\n` +
      `   * keys registered via trackPokemonCryKey(). pruneStaleAssets() frees whichever\n` +
      `   * of these getActiveKeys() no longer protects. See prune-stale-pokemon-assets.js\n` +
      `   * header comment for the full design/safety reasoning.\n` +
      `   */\n` +
      `  private readonly trackedPokemonSpriteKeys = new Set<string>();\n` +
      `  private readonly trackedPokemonCryKeys = new Set<string>();\n` +
      `\n` +
      `  /** Offline: registers a cry audio key loaded outside loadPokemonAtlas() (see trackedPokemonCryKeys). */\n` +
      `  public trackPokemonCryKey(key: string): void {\n` +
      `    this.trackedPokemonCryKeys.add(key);\n` +
      `  }\n` +
      `\n` +
      `  /**\n` +
      `   * Offline: returns the texture keys of every Sprite/Image/NineSlice\n` +
      `   * currently in the scene's display list (recursively, through nested\n` +
      `   * Containers - including Pokemon/Trainer/MysteryEncounterIntroVisuals,\n` +
      `   * which are themselves Containers). pruneStaleAssets() and\n` +
      `   * clearBiomeAssets() both use this so a key is never freed while\n` +
      `   * something on screen is still rendering it, even if that GameObject\n` +
      `   * belongs to a Pokemon not counted by getActiveKeys() (e.g. a just-\n` +
      `   * hatched egg Pokemon not yet in the party - see this patch's "v3"\n` +
      `   * header comment for the crash this fixes).\n` +
      `   */\n` +
      `  private getInUseTextureKeys(): Set<string> {\n` +
      `    const inUseKeys = new Set<string>();\n` +
      `    const walk = (obj: any): void => {\n` +
      `      if (!obj) {\n` +
      `        return;\n` +
      `      }\n` +
      `      if (typeof obj.texture?.key === "string") {\n` +
      `        inUseKeys.add(obj.texture.key);\n` +
      `      }\n` +
      `      if (Array.isArray(obj.list)) {\n` +
      `        obj.list.forEach(walk);\n` +
      `      }\n` +
      `    };\n` +
      `    this.children.list.forEach(walk);\n` +
      `    return inUseKeys;\n` +
      `  }\n` +
      `\n` +
      `  /**\n` +
      `   * Offline: frees Pokemon sprite textures/anims and cry audio buffers loaded\n` +
      `   * for a Pokemon no longer on the field (party or enemy, current wave - see\n` +
      `   * getActiveKeys()). Intended to run right after a wave transition, once\n` +
      `   * getActiveKeys() already reflects the *new* wave's combatants, so only the\n` +
      `   * *previous* wave's now-irrelevant assets get freed (see new-battle-phase.ts).\n` +
      `   *\n` +
      `   * Gated by settings.offline.aggressiveMemorySaving - a no-op when off, so this\n` +
      `   * can be disabled instantly without a new build if an edge case (e.g. a\n` +
      `   * one-off Mystery Encounter preview sprite) is ever evicted while still\n` +
      `   * needed. Safe by design otherwise: every code path that displays a Pokemon\n` +
      `   * sprite already calls loadAssets()/loadPokemonAtlas() and awaits it before\n` +
      `   * playing the animation (e.g. PokedexUiHandler does this for species not on\n` +
      `   * the current field), so re-requesting an evicted key is the same lazy-load\n` +
      `   * path that already runs today, not a new one.\n` +
      `   *\n` +
      `   * Each individual removal is wrapped in try/catch so a single unexpected\n` +
      `   * failure (e.g. Phaser throwing because some other GameObject unexpectedly\n` +
      `   * still references a key we thought was safe to free - see the warning in\n` +
      `   * Phaser's own TextureManager.remove() doc comment) is logged and skipped\n` +
      `   * rather than crashing the whole prune pass / phase transition. That\n` +
      `   * try/catch runs in every build. The logging itself (a one-line summary per\n` +
      `   * call, both console-logged and persisted to localStorage) only runs when\n` +
      `   * isScoomDev is true - see this patch's "v2" header comment for why that's\n` +
      `   * a separate flag from upstream's own isDev, and the exact console command\n` +
      `   * to read the persisted log back after a crash.\n` +
      `   */\n` +
      `  public pruneStaleAssets(): void {\n` +
      `    if (!settings.offline.aggressiveMemorySaving) {\n` +
      `      return;\n` +
      `    }\n` +
      `\n` +
      `    const debugLogging = isScoomDev;\n` +
      `    const activeKeys = new Set(this.getActiveKeys());\n` +
      `    const inUseKeys = this.getInUseTextureKeys();\n` +
      `    let spritesFreed = 0;\n` +
      `    let criesFreed = 0;\n` +
      `    let errors = 0;\n` +
      `\n` +
      `    for (const key of this.trackedPokemonSpriteKeys) {\n` +
      `      if (activeKeys.has(key) || inUseKeys.has(key)) {\n` +
      `        continue;\n` +
      `      }\n` +
      `      try {\n` +
      `        if (this.anims.exists(key)) {\n` +
      `          this.anims.remove(key);\n` +
      `        }\n` +
      `        if (this.textures.exists(key)) {\n` +
      `          this.textures.remove(key);\n` +
      `          spritesFreed++;\n` +
      `        }\n` +
      `      } catch (err) {\n` +
      `        errors++;\n` +
      `        if (debugLogging) {\n` +
      `          console.error(\`[memory-patch] Failed to free sprite key "\${key}":\`, err);\n` +
      `          appendMemoryDebugLog(\`ERROR freeing sprite "\${key}": \${err}\`);\n` +
      `        }\n` +
      `      }\n` +
      `      this.trackedPokemonSpriteKeys.delete(key);\n` +
      `    }\n` +
      `\n` +
      `    for (const key of this.trackedPokemonCryKeys) {\n` +
      `      if (activeKeys.has(key)) {\n` +
      `        continue;\n` +
      `      }\n` +
      `      try {\n` +
      `        if (this.cache.audio.exists(key)) {\n` +
      `          this.cache.audio.remove(key);\n` +
      `          criesFreed++;\n` +
      `        }\n` +
      `      } catch (err) {\n` +
      `        errors++;\n` +
      `        if (debugLogging) {\n` +
      `          console.error(\`[memory-patch] Failed to free cry key "\${key}":\`, err);\n` +
      `          appendMemoryDebugLog(\`ERROR freeing cry "\${key}": \${err}\`);\n` +
      `        }\n` +
      `      }\n` +
      `      this.trackedPokemonCryKeys.delete(key);\n` +
      `    }\n` +
      `\n` +
      `    if (debugLogging) {\n` +
      `      const summary =\n` +
      `        \`wave=\${this.currentBattle?.waveIndex ?? "?"} freed=\${spritesFreed}sprite(s)/\${criesFreed}cry(ies)\` +\n` +
      `        \` tracked=\${this.trackedPokemonSpriteKeys.size + spritesFreed}/\${this.trackedPokemonCryKeys.size + criesFreed}\` +\n` +
      `        \` active=\${activeKeys.size}\${errors ? \` errors=\${errors}\` : ""}\`;\n` +
      `      console.log(\`[memory-patch] pruneStaleAssets: \${summary}\`);\n` +
      `      appendMemoryDebugLog(summary);\n` +
      `    }\n` +
      `  }\n` +
      `\n` +
      `  /**\n` +
      `   * This function retrieves the sprite and audio keys for active Pokemon.\n` +
      `   * Active Pokemon include both enemy and player Pokemon of the current wave.\n` +
      `   * Note: Questions on garbage collection go to \`@frutescens\`\n` +
      `   * @returns a string array of active sprite and audio keys that should not be deleted\n` +
      `   */\n` +
      `  getActiveKeys(): string[] {`,
  );

  // 1e. clearBiomeAssets() predates this patch and has the exact same gap
  // getInUseTextureKeys() above fixes for pruneStaleAssets() - a hardcoded
  // key list freed with no check that arenaBg/arenaPlayer/arenaEnemy etc.
  // actually released the key first. Reuse the same helper here.
  const CLEAR_BIOME_ANCHOR =
    `    for (const key of keysToClear) {\n` +
    `      if (this.anims.exists(key)) {\n` +
    `        console.log(\`Removing animation for key \${key}..\`);\n` +
    `        this.anims.remove(key);\n` +
    `      }\n` +
    `\n` +
    `      if (this.textures.exists(key)) {\n` +
    `        this.textures.remove(key);\n` +
    `      }\n` +
    `    }\n` +
    `  }`;
  requireAnchor(battleSceneSrc, CLEAR_BIOME_ANCHOR, "clearBiomeAssets() eviction loop in battle-scene.ts");
  battleSceneSrc = battleSceneSrc.replace(
    CLEAR_BIOME_ANCHOR,
    `    const inUseKeys = this.getInUseTextureKeys();\n` +
      `    for (const key of keysToClear) {\n` +
      `      if (this.anims.exists(key)) {\n` +
      `        console.log(\`Removing animation for key \${key}..\`);\n` +
      `        this.anims.remove(key);\n` +
      `      }\n` +
      `\n` +
      `      if (this.textures.exists(key) && !inUseKeys.has(key)) {\n` +
      `        this.textures.remove(key);\n` +
      `      }\n` +
      `    }\n` +
      `  }`,
  );

  writeFile(BATTLE_SCENE_PATH, battleSceneSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/data/pokemon-species.ts
// ─────────────────────────────────────────────────────────────────────────────

const SPECIES_PATH = path.join("pokerogue-src", "src", "data", "pokemon-species.ts");
let speciesSrc = readFile(SPECIES_PATH);

if (speciesSrc.includes("trackPokemonCryKey")) {
  console.log("SKIP pokemon-species.ts — trackPokemonCryKey call already present");
} else {
  const CRY_LOAD_ANCHOR =
    `    globalScene.loadPokemonAtlas(spriteKey, this.getSpriteAtlasPath(female, formIndex, shiny, variant, back));\n` +
    `    // TODO: this should be routed through audiomanager rather than a raw \`load.audio\` call\n` +
    `    if (audioManager.isAudioEnabled) {\n` +
    `      globalScene.load.audio(this.getCryKey(formIndex), \`audio/\${this.getCryKey(formIndex)}.m4a\`);\n` +
    `    }`;
  requireAnchor(speciesSrc, CRY_LOAD_ANCHOR, "cry audio load in loadAssets() in pokemon-species.ts");
  speciesSrc = speciesSrc.replace(
    CRY_LOAD_ANCHOR,
    `    globalScene.loadPokemonAtlas(spriteKey, this.getSpriteAtlasPath(female, formIndex, shiny, variant, back));\n` +
      `    // TODO: this should be routed through audiomanager rather than a raw \`load.audio\` call\n` +
      `    if (audioManager.isAudioEnabled) {\n` +
      `      const cryKey = this.getCryKey(formIndex);\n` +
      `      globalScene.load.audio(cryKey, \`audio/\${cryKey}.m4a\`);\n` +
      `      // Offline: register so pruneStaleAssets() can free this cry once no active\n` +
      `      // Pokemon uses it (see battle-scene.ts).\n` +
      `      globalScene.trackPokemonCryKey(cryKey);\n` +
      `    }`,
  );

  writeFile(SPECIES_PATH, speciesSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 3: src/phases/new-battle-phase.ts
// ─────────────────────────────────────────────────────────────────────────────

const NEW_BATTLE_PHASE_PATH = path.join("pokerogue-src", "src", "phases", "new-battle-phase.ts");
let newBattlePhaseSrc = readFile(NEW_BATTLE_PHASE_PATH);

if (newBattlePhaseSrc.includes("pruneStaleAssets")) {
  console.log("SKIP new-battle-phase.ts — pruneStaleAssets call already present");
} else {
  const NEW_BATTLE_ANCHOR =
    `    globalScene.phaseManager.removeAllPhasesOfType("NewBattlePhase");\n` + `\n` + `    globalScene.newBattle();\n`;
  requireAnchor(newBattlePhaseSrc, NEW_BATTLE_ANCHOR, "globalScene.newBattle() call in NewBattlePhase.start()");
  newBattlePhaseSrc = newBattlePhaseSrc.replace(
    NEW_BATTLE_ANCHOR,
    `    globalScene.phaseManager.removeAllPhasesOfType("NewBattlePhase");\n` +
      `\n` +
      `    globalScene.newBattle();\n` +
      `    // Offline: getActiveKeys() now reflects the new wave's combatants, so this\n` +
      `    // only frees sprites/cries left over from the *previous* wave.\n` +
      `    globalScene.pruneStaleAssets();\n`,
  );

  writeFile(NEW_BATTLE_PHASE_PATH, newBattlePhaseSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 4: src/render-nodes/field-sprite.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// Phaser 4 port (see "v4" header comment above for the full reasoning on why
// this has to override run() rather than setRenderOptions(), and why one
// override on the base FieldSpriteSubmitter covers both arena/trainer field
// sprites and Pokemon sprites without needing a separate sprite.ts sub-patch).

const FIELD_SPRITE_RENDER_NODE_PATH = path.join("pokerogue-src", "src", "render-nodes", "field-sprite.ts");
let fieldSpriteRenderNodeSrc = readFile(FIELD_SPRITE_RENDER_NODE_PATH);

if (fieldSpriteRenderNodeSrc.includes("gameObject.frame?.source")) {
  console.log("SKIP field-sprite.ts — run() eviction guard already present");
} else {
  const SET_RENDER_OPTIONS_ANCHOR =
    `  public override setRenderOptions(gameObject: GameObject, normalMap?: any, normalMapRotation?: number): void {\n` +
    `    super.setRenderOptions(gameObject, normalMap, normalMapRotation);\n` +
    `\n` +
    `    // Port of the per-object part of v3 onBind\n` +
    `    const data = (gameObject as Sprite).renderNodeData[this.name] as FieldSpriteRenderData | undefined;`;
  requireAnchor(
    fieldSpriteRenderNodeSrc,
    SET_RENDER_OPTIONS_ANCHOR,
    "FieldSpriteSubmitter.setRenderOptions() in render-nodes/field-sprite.ts",
  );
  fieldSpriteRenderNodeSrc = fieldSpriteRenderNodeSrc.replace(
    SET_RENDER_OPTIONS_ANCHOR,
    `  /**\n` +
      `   * Offline: a sprite whose texture was evicted by pruneStaleAssets()/\n` +
      `   * clearBiomeAssets() between frames has no texture source left.\n` +
      `   * Phaser's own SubmitterQuad.run() reads \`texturerNode.frame.source.glTexture\`\n` +
      `   * unconditionally after setRenderOptions() runs (and doesn't check this\n` +
      `   * method's return value), so the guard has to live here, before\n` +
      `   * super.run() is called at all - see prune-stale-pokemon-assets.js's "v4"\n` +
      `   * header comment for why setRenderOptions() itself can't prevent the crash.\n` +
      `   * Hiding the GameObject also makes future frames skip it via willRender().\n` +
      `   */\n` +
      `  public override run(...args: Parameters<Phaser.Renderer.WebGL.RenderNodes.SubmitterQuad["run"]>): void {\n` +
      `    const gameObject = args[1] as Sprite;\n` +
      `    if (!gameObject.frame?.source) {\n` +
      `      gameObject.setVisible(false);\n` +
      `      return;\n` +
      `    }\n` +
      `    super.run(...args);\n` +
      `  }\n` +
      `\n` +
      `${SET_RENDER_OPTIONS_ANCHOR}`,
  );

  writeFile(FIELD_SPRITE_RENDER_NODE_PATH, fieldSpriteRenderNodeSrc);
}

console.log("Stale Pokemon asset pruning applied successfully.");
