#!/usr/bin/env node
/**
 * Patch: prune-stale-move-anim-assets.js
 *
 * Sibling fix to prune-stale-pokemon-assets.js, for issue #11 idea #2
 * (reported and prototyped by @mleo2003): loadMoveAnimAssets() loads a
 * move's spritesheet, background images and battle_anims/* sound effects
 * the first time it's needed, but nothing ever frees them - every distinct
 * move animation seen in a run (theirs or an opponent's) accumulates in the
 * texture/audio cache for the rest of the session. Reporter measured ~80MB
 * of textures + ~175MB of decoded sound effects by wave 145, a major
 * contributor to the WebView OOM crash issue #11 as a whole is about.
 *
 * Fix: BattleScene.pruneMoveAnimAssets(), modeled directly on the existing
 * pruneStaleAssets() right above it (same file, same
 * settings.offline.aggressiveMemorySaving gate, same try/catch-per-removal
 * and isScoomDev-gated appendMemoryDebugLog() summary). "Keep" = every
 * graphic/background/sound-effect referenced by commonAnims, encounterAnims,
 * chargeAnims (always loaded, never move-specific), plus every move actually
 * known by either party right now, plus anything getInUseTextureKeys() says
 * is still on screen. Everything else in moveAnims' own asset set gets
 * evicted. Nothing evicted here is unsafe to lose: loadMoveAnimAssets() is
 * the same lazy-load path Pokemon.loadAssets()/LoadMoveAnimPhase already use
 * on demand (e.g. for Metronome-called moves not yet loaded), so re-loading
 * an evicted key on next use is a normal, already-exercised path, not a new
 * one - identical reasoning to prune-stale-pokemon-assets.js's own safety
 * argument.
 *
 * Called from new-battle-phase.ts right after the existing
 * pruneStaleAssets() call - NOT mleo2003's original standalone module, which
 * polled arena.biomeId every 2s and waited 8s after a detected biome change
 * before pruning, to approximate "the new wave's party/moveset is settled"
 * from outside the engine. Inside the engine, NewBattlePhase.start() already
 * guarantees that (it's the exact precondition pruneStaleAssets() itself
 * already relies on), so no timer/polling/biome-tracking state is needed -
 * at the cost of running every wave rather than only on biome change (a bit
 * more evict/reload churn within one biome), the same cadence/trade-off
 * pruneStaleAssets() already ships with.
 *
 * Also folds in the smaller, separate leak mleo2003 flagged in the same
 * reply: globalScene.sound.play() only destroys a one-shot sound on its
 * COMPLETE event (Phaser's own BaseSoundManager behavior), so a sound effect
 * stopped/interrupted before finishing stays in sound.sounds forever (they
 * measured 127 after ~40 waves). pruneMoveAnimAssets() also sweeps idle
 * (not playing, not paused) se/, battle_anims/ and cry/ sound instances out
 * of sound.sounds every time it runs. Never touches music.
 *
 * Depends on prune-stale-pokemon-assets.js having already run (anchors on
 * code that patch introduces) - apply-patches.sh runs this right after it,
 * inside the same MEMORY_PATCHES_ENABLED gate.
 *
 * Targets: pokerogue-src/src/battle-scene.ts,
 *          pokerogue-src/src/phases/new-battle-phase.ts
 */

const fs = require("fs");
const path = require("path");

function patchBattleScene() {
  const TARGET = path.join("pokerogue-src", "src", "battle-scene.ts");

  if (!fs.existsSync(TARGET)) {
    console.error(`ERROR: Could not find target file: ${TARGET}`);
    process.exit(1);
  }

  let src = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");

  if (src.includes("pruneMoveAnimAssets")) {
    console.log("prune-stale-move-anim-assets already applied to battle-scene.ts, skipping.");
    return;
  }

  const IMPORT_ANCHOR = `import { initCommonAnims, initMoveAnim, loadCommonAnimAssets, loadMoveAnimAssets } from "#data/battle-anims";`;

  if (!src.includes(IMPORT_ANCHOR)) {
    console.error("ERROR: Could not find the battle-anims import line in battle-scene.ts.");
    process.exit(1);
  }

  const IMPORT_REPLACEMENT = `import {
  type AnimConfig,
  chargeAnims,
  commonAnims,
  encounterAnims,
  initCommonAnims,
  initMoveAnim,
  loadCommonAnimAssets,
  loadMoveAnimAssets,
  moveAnims,
} from "#data/battle-anims";`;

  src = src.replace(IMPORT_ANCHOR, IMPORT_REPLACEMENT);

  const METHOD_ANCHOR = `      console.log(\`[memory-patch] pruneStaleAssets: \${summary}\`);
      appendMemoryDebugLog(summary);
    }
  }
`;

  if (!src.includes(METHOD_ANCHOR)) {
    console.error("ERROR: Could not find the pruneStaleAssets()/getActiveKeys() boundary in battle-scene.ts.");
    process.exit(1);
  }

  const NEW_METHOD = `
  /**
   * Offline: frees move-animation textures/backgrounds/sound-effect buffers
   * (loaded by loadMoveAnimAssets() for a move the first time it's used) once
   * no Pokemon on either side of the field still knows that move. Keeps
   * anything referenced by commonAnims/encounterAnims/chargeAnims (always
   * loaded, not move-specific) and anything getInUseTextureKeys() says is
   * still on screen. Also sweeps idle (not playing, not paused) se/,
   * battle_anims/ and cry/ Sound instances out of this.sound.sounds - Phaser
   * only destroys a one-shot sound automatically on its COMPLETE event, so
   * one stopped/interrupted early (e.g. by a faster subsequent move) is
   * otherwise never cleaned up. See prune-stale-move-anim-assets.js header
   * comment for the full design/safety reasoning - same
   * settings.offline.aggressiveMemorySaving gate and try/catch-per-removal
   * pattern as pruneStaleAssets() above.
   */
  public pruneMoveAnimAssets(): void {
    if (!settings.offline.aggressiveMemorySaving) {
      return;
    }

    const debugLogging = isScoomDev;

    const collect = (
      configs: Iterable<AnimConfig | [AnimConfig, AnimConfig] | null | undefined>,
      gfx: Set<string>,
      bg: Set<string>,
      se: Set<string>,
    ): void => {
      for (const config of configs) {
        const variants = Array.isArray(config) ? config : [config];
        for (const anim of variants) {
          if (!anim) {
            continue;
          }
          if (anim.graphic) {
            gfx.add(anim.graphic);
          }
          for (const name of anim.getBackgroundResourceNames()) {
            bg.add(name);
          }
          for (const name of anim.getSoundResourceNames()) {
            se.add(name);
          }
        }
      }
    };

    const keepGfx = new Set<string>();
    const keepBg = new Set<string>();
    const keepSe = new Set<string>();
    collect(commonAnims.values(), keepGfx, keepBg, keepSe);
    collect(encounterAnims.values(), keepGfx, keepBg, keepSe);
    collect(chargeAnims.values(), keepGfx, keepBg, keepSe);

    const activeMoveIds = new Set<number>();
    let activePokemon: (PlayerPokemon | EnemyPokemon)[] = this.getPlayerParty();
    activePokemon = activePokemon.concat(this.getEnemyParty());
    for (const p of activePokemon) {
      for (const move of p.getMoveset()) {
        activeMoveIds.add(move.moveId);
      }
    }
    collect(
      Array.from(activeMoveIds).map(id => moveAnims.get(id)),
      keepGfx,
      keepBg,
      keepSe,
    );

    const allGfx = new Set<string>();
    const allBg = new Set<string>();
    const allSe = new Set<string>();
    collect(moveAnims.values(), allGfx, allBg, allSe);

    const inUseKeys = this.getInUseTextureKeys();
    let texturesFreed = 0;
    let soundsFreed = 0;
    let soundsSwept = 0;
    let errors = 0;

    for (const key of new Set([...allGfx, ...allBg])) {
      if (keepGfx.has(key) || keepBg.has(key) || inUseKeys.has(key)) {
        continue;
      }
      try {
        if (this.textures.exists(key)) {
          this.textures.remove(key);
          texturesFreed++;
        }
      } catch (err) {
        errors++;
        if (debugLogging) {
          console.error(\`[memory-patch] Failed to free move-anim texture "\${key}":\`, err);
          appendMemoryDebugLog(\`ERROR freeing move-anim texture "\${key}": \${err}\`);
        }
      }
    }

    for (const name of allSe) {
      if (keepSe.has(name)) {
        continue;
      }
      const key = \`battle_anims/\${name}\`;
      if (this.sound.getAll(key).some(s => s.isPlaying)) {
        continue;
      }
      try {
        if (this.cache.audio.exists(key)) {
          this.cache.audio.remove(key);
          this.sound.removeByKey(key);
          soundsFreed++;
        }
      } catch (err) {
        errors++;
        if (debugLogging) {
          console.error(\`[memory-patch] Failed to free move-anim sound "\${key}":\`, err);
          appendMemoryDebugLog(\`ERROR freeing move-anim sound "\${key}": \${err}\`);
        }
      }
    }

    // NoAudioSoundManager (used when Web/HTML5 Audio are unavailable) doesn't
    // declare \`sounds\` - it's a no-op stub with nothing to sweep either way.
    const allSounds: Phaser.Sound.BaseSound[] = (this.sound as any).sounds ?? [];
    for (const s of [...allSounds]) {
      if (/^(se|battle_anims|cry)\\//.test(s.key) && !s.isPlaying && !s.isPaused) {
        try {
          s.destroy();
          soundsSwept++;
        } catch (err) {
          errors++;
          if (debugLogging) {
            console.error(\`[memory-patch] Failed to sweep idle sound "\${s.key}":\`, err);
            appendMemoryDebugLog(\`ERROR sweeping idle sound "\${s.key}": \${err}\`);
          }
        }
      }
    }

    if (debugLogging) {
      const summary =
        \`wave=\${this.currentBattle?.waveIndex ?? "?"} freed=\${texturesFreed}texture(s)/\${soundsFreed}sound(s)\` +
        \` swept=\${soundsSwept}idle-sound(s) kept=\${activeMoveIds.size}move(s)\${errors ? \` errors=\${errors}\` : ""}\`;
      console.log(\`[memory-patch] pruneMoveAnimAssets: \${summary}\`);
      appendMemoryDebugLog(summary);
    }
  }
`;

  src = src.replace(METHOD_ANCHOR, `${METHOD_ANCHOR}${NEW_METHOD}`);

  fs.writeFileSync(TARGET, src, "utf8");
  console.log("Patched battle-scene.ts: added pruneMoveAnimAssets().");
}

function patchNewBattlePhase() {
  const TARGET = path.join("pokerogue-src", "src", "phases", "new-battle-phase.ts");

  if (!fs.existsSync(TARGET)) {
    console.error(`ERROR: Could not find target file: ${TARGET}`);
    process.exit(1);
  }

  let src = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");

  if (src.includes("pruneMoveAnimAssets")) {
    console.log("prune-stale-move-anim-assets already applied to new-battle-phase.ts, skipping.");
    return;
  }

  const ANCHOR = `    globalScene.pruneStaleAssets();`;

  if (!src.includes(ANCHOR)) {
    console.error("ERROR: Could not find the pruneStaleAssets() call in new-battle-phase.ts.");
    process.exit(1);
  }

  const REPLACEMENT = `    globalScene.pruneStaleAssets();
    // Offline: same reasoning as pruneStaleAssets() above - both parties'
    // movesets for the new wave are already current at this point.
    globalScene.pruneMoveAnimAssets();`;

  src = src.replace(ANCHOR, REPLACEMENT);

  fs.writeFileSync(TARGET, src, "utf8");
  console.log("Patched new-battle-phase.ts: added pruneMoveAnimAssets() call.");
}

patchBattleScene();
patchNewBattlePhase();
