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
 * Targets: pokerogue-src/src/battle-scene.ts
 *          pokerogue-src/src/data/pokemon-species.ts
 *          pokerogue-src/src/phases/new-battle-phase.ts
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
// Sub-patch 1: src/battle-scene.ts
// ─────────────────────────────────────────────────────────────────────────────

const BATTLE_SCENE_PATH = path.join("pokerogue-src", "src", "battle-scene.ts");
let battleSceneSrc = readFile(BATTLE_SCENE_PATH);

if (battleSceneSrc.includes("pruneStaleAssets")) {
  console.log("SKIP battle-scene.ts — pruneStaleAssets already present");
} else {
  // 1a. Register every sprite atlas key the moment it's queued for load -
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

  // 1b. New tracking Sets + trackPokemonCryKey() + pruneStaleAssets(), right
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
      `   */\n` +
      `  public pruneStaleAssets(): void {\n` +
      `    if (!settings.offline.aggressiveMemorySaving) {\n` +
      `      return;\n` +
      `    }\n` +
      `\n` +
      `    const activeKeys = new Set(this.getActiveKeys());\n` +
      `\n` +
      `    for (const key of this.trackedPokemonSpriteKeys) {\n` +
      `      if (activeKeys.has(key)) {\n` +
      `        continue;\n` +
      `      }\n` +
      `      if (this.anims.exists(key)) {\n` +
      `        this.anims.remove(key);\n` +
      `      }\n` +
      `      if (this.textures.exists(key)) {\n` +
      `        this.textures.remove(key);\n` +
      `      }\n` +
      `      this.trackedPokemonSpriteKeys.delete(key);\n` +
      `    }\n` +
      `\n` +
      `    for (const key of this.trackedPokemonCryKeys) {\n` +
      `      if (activeKeys.has(key)) {\n` +
      `        continue;\n` +
      `      }\n` +
      `      if (this.cache.audio.exists(key)) {\n` +
      `        this.cache.audio.remove(key);\n` +
      `      }\n` +
      `      this.trackedPokemonCryKeys.delete(key);\n` +
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
    `    globalScene.load.audio(this.getCryKey(formIndex), \`audio/\${this.getCryKey(formIndex)}.m4a\`);`;
  requireAnchor(speciesSrc, CRY_LOAD_ANCHOR, "cry audio load in loadAssets() in pokemon-species.ts");
  speciesSrc = speciesSrc.replace(
    CRY_LOAD_ANCHOR,
    `    globalScene.loadPokemonAtlas(spriteKey, this.getSpriteAtlasPath(female, formIndex, shiny, variant, back));\n` +
      `    const cryKey = this.getCryKey(formIndex);\n` +
      `    globalScene.load.audio(cryKey, \`audio/\${cryKey}.m4a\`);\n` +
      `    // Offline: register so pruneStaleAssets() can free this cry once no active\n` +
      `    // Pokemon uses it (see battle-scene.ts).\n` +
      `    globalScene.trackPokemonCryKey(cryKey);`,
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

console.log("Stale Pokemon asset pruning applied successfully.");
