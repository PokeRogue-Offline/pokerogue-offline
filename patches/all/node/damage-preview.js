#!/usr/bin/env node
/**
 * Patch: damage-preview.js
 *
 * Adds an optional fight-menu preview: a damage-range/KO-label line next to
 * each enemy's own info box (mirroring the existing type-effectiveness
 * hint), and an enemy HP% line next to the HP bar. Both are off by default
 * and independently toggleable via two new Offline-tab settings
 * ("Damage Range" / "Enemy HP %").
 *
 * The actual math lives entirely in new-files/src/ui/damage-preview.ts,
 * which calls the game's own Pokemon.getAttackDamage() (simulated mode,
 * exactly like the existing effectiveness hint and the enemy AI's KO-check
 * already do) and the game's own exported calculateBossSegmentDamage() for
 * boss-shield clamping - no damage formula is reimplemented here. See that
 * file's doc comment for the full design.
 *
 * Sub-patches, applied in order:
 *
 *   1. src/ui/damage-preview.ts,
 *      src/system/offline/damage-preview-settings.ts,
 *      test/tests/ui/damage-preview.test.ts  (new files)
 *
 *   2. src/ui/handlers/fight-ui-handler.ts
 *        New imports; in setMoveInfo()'s existing per-opponent forEach,
 *        additionally compute and forward the damage-range text. Also
 *        clears the damage-range hint in clearMoves(), mirroring the
 *        pre-existing updateEffectiveness() clear.
 *
 *   3. src/ui/battle-info/enemy-battle-info.ts
 *        New imports; new fields + construction for the damage-range
 *        container/text and the HP% text (same window/container pattern as
 *        the existing effectiveness hint); a new updateDamageRange() method
 *        mirroring updateEffectiveness(); a new private updateHpPercentText()
 *        helper, hooked into the existing updatePokemonHp() override and
 *        updateBossSegments() (both already fire on exactly the events that
 *        change HP/segment state).
 *
 *   4. src/field/pokemon.ts
 *        New updateDamageRange() forwarding method on EnemyPokemon,
 *        mirroring the pre-existing updateEffectiveness() forwarding method
 *        it sits next to (both simply delegate to this.battleInfo).
 *        Required because fight-ui-handler.ts calls updateDamageRange() on
 *        the EnemyPokemon instance itself, not on its battleInfo.
 *
 * Depends on app-settings-menu.js having already run (this patch's settings
 * additions live in that file's sub-patch 6, sharing its single anchor into
 * settings.ts's Setting[] array - adding a second patch touching the same
 * array risks anchor collisions between the two scripts). Must be applied
 * after app-settings-menu.js.
 *
 * Targets: pokerogue-src/src/ui/handlers/fight-ui-handler.ts
 *          pokerogue-src/src/ui/battle-info/enemy-battle-info.ts
 *          pokerogue-src/src/field/pokemon.ts
 *          pokerogue-src/src/ui/damage-preview.ts (new file)
 *          pokerogue-src/src/system/offline/damage-preview-settings.ts (new file)
 *          pokerogue-src/test/tests/ui/damage-preview.test.ts (new file)
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

// This patch script lives at patches/all/node/damage-preview.js in the
// pkr-offline repo. The new source files it writes are checked into this
// same repo (under new-files/) so this script and its payload stay together.
const NEW_FILES_DIR = path.join(__dirname, "..", "..", "..", "new-files");

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1: new files
// ─────────────────────────────────────────────────────────────────────────────

function copyNewFile(relativePath) {
  const targetPath = path.join("pokerogue-src", relativePath);
  if (fs.existsSync(targetPath)) {
    console.log(`SKIP ${relativePath} — already exists`);
    return;
  }
  const contents = fs.readFileSync(path.join(NEW_FILES_DIR, relativePath), "utf8");
  writeFile(targetPath, contents);
}

copyNewFile(path.join("src", "ui", "damage-preview.ts"));
copyNewFile(path.join("src", "system", "offline", "damage-preview-settings.ts"));
copyNewFile(path.join("test", "tests", "ui", "damage-preview.test.ts"));

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/ui/handlers/fight-ui-handler.ts
// ─────────────────────────────────────────────────────────────────────────────

const FIGHT_UI_PATH = path.join("pokerogue-src", "src", "ui", "handlers", "fight-ui-handler.ts");
let fightUiSrc = readFile(FIGHT_UI_PATH);

if (fightUiSrc.includes("updateDamageRange")) {
  console.log("SKIP fight-ui-handler.ts — damage preview hook already present");
} else {
  const IMPORT_ANCHOR = `import { MoveInfoOverlay } from "#ui/move-info-overlay";\n`;
  requireAnchor(fightUiSrc, IMPORT_ANCHOR, 'MoveInfoOverlay import in fight-ui-handler.ts');
  fightUiSrc = fightUiSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}` +
      `import { computeDamageRangeText } from "#ui/damage-preview";\n` +
      `import { isDamageRangeEnabled } from "#system/offline/damage-preview-settings";\n`,
  );

  const FOR_EACH_ANCHOR =
    `    pokemon.getOpponents().forEach(opponent => {\n` +
    `      (opponent as EnemyPokemon).updateEffectiveness(this.getEffectivenessText(pokemon, opponent, pokemonMove));\n` +
    `    });`;
  requireAnchor(fightUiSrc, FOR_EACH_ANCHOR, "per-opponent effectiveness forEach in setMoveInfo()");
  fightUiSrc = fightUiSrc.replace(
    FOR_EACH_ANCHOR,
    `    pokemon.getOpponents().forEach(opponent => {\n` +
      `      const enemy = opponent as EnemyPokemon;\n` +
      `      enemy.updateEffectiveness(this.getEffectivenessText(pokemon, opponent, pokemonMove));\n` +
      `      // Offline: damage-range preview, off by default (Offline settings tab).\n` +
      `      enemy.updateDamageRange(\n` +
      `        isDamageRangeEnabled() ? computeDamageRangeText(pokemon, enemy, pokemonMove.getMove()) : undefined,\n` +
      `      );\n` +
      `    });`,
  );

  const CLEAR_MOVES_ANCHOR =
    `  clearMoves() {\n` +
    `    this.movesContainer.removeAll(true);\n` +
    `\n` +
    `    const opponents = (globalScene.phaseManager.getCurrentPhase() as CommandPhase).getPokemon().getOpponents();\n` +
    `    opponents.forEach(opponent => {\n` +
    `      (opponent as EnemyPokemon).updateEffectiveness();\n` +
    `    });\n` +
    `  }`;
  requireAnchor(fightUiSrc, CLEAR_MOVES_ANCHOR, "clearMoves() per-opponent effectiveness-clear forEach in fight-ui-handler.ts");
  fightUiSrc = fightUiSrc.replace(
    CLEAR_MOVES_ANCHOR,
    `  clearMoves() {\n` +
      `    this.movesContainer.removeAll(true);\n` +
      `\n` +
      `    const opponents = (globalScene.phaseManager.getCurrentPhase() as CommandPhase).getPokemon().getOpponents();\n` +
      `    opponents.forEach(opponent => {\n` +
      `      const enemy = opponent as EnemyPokemon;\n` +
      `      enemy.updateEffectiveness();\n` +
      `      // Offline: also clear the damage-range hint so it doesn't stay stuck\n` +
      `      // showing stale text after backing out of the Fight menu.\n` +
      `      enemy.updateDamageRange();\n` +
      `    });\n` +
      `  }`,
  );

  writeFile(FIGHT_UI_PATH, fightUiSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 3: src/ui/battle-info/enemy-battle-info.ts
// ─────────────────────────────────────────────────────────────────────────────

const ENEMY_INFO_PATH = path.join("pokerogue-src", "src", "ui", "battle-info", "enemy-battle-info.ts");
let enemyInfoSrc = readFile(ENEMY_INFO_PATH);

if (enemyInfoSrc.includes("updateDamageRange")) {
  console.log("SKIP enemy-battle-info.ts — damage preview hook already present");
} else {
  // 3a. New imports.
  const ENEMY_IMPORT_ANCHOR = `import { addTextObject } from "#ui/text";\n`;
  requireAnchor(enemyInfoSrc, ENEMY_IMPORT_ANCHOR, "addTextObject import in enemy-battle-info.ts");
  enemyInfoSrc = enemyInfoSrc.replace(
    ENEMY_IMPORT_ANCHOR,
    `${ENEMY_IMPORT_ANCHOR}` +
      `import { computeHpPercentText } from "#ui/damage-preview";\n` +
      `import { isEnemyHpPercentEnabled } from "#system/offline/damage-preview-settings";\n`,
  );

  // 3b. New fields, adjacent to the existing effectiveness-hint fields.
  const FIELDS_ANCHOR =
    `  protected effectivenessContainer: Phaser.GameObjects.Container;\n` +
    `  protected effectivenessWindow: Phaser.GameObjects.NineSlice;\n` +
    `  protected effectivenessText: Phaser.GameObjects.Text;\n` +
    `  protected currentEffectiveness?: string | undefined;\n` +
    `\n` +
    `  // #endregion Type effectiveness hint objects`;
  requireAnchor(enemyInfoSrc, FIELDS_ANCHOR, "effectiveness hint field block in enemy-battle-info.ts");
  enemyInfoSrc = enemyInfoSrc.replace(
    FIELDS_ANCHOR,
    `${FIELDS_ANCHOR}\n` +
      `\n` +
      `  // #region Offline: damage range / HP% preview objects\n` +
      `\n` +
      `  protected damageRangeContainer: Phaser.GameObjects.Container;\n` +
      `  protected damageRangeWindow: Phaser.GameObjects.NineSlice;\n` +
      `  protected damageRangeText: Phaser.GameObjects.Text;\n` +
      `  protected hpPercentText: Phaser.GameObjects.Text;\n` +
      `\n` +
      `  // #endregion Offline: damage range / HP% preview objects`,
  );

  // 3c. Construction, right after the existing effectiveness hint's construction in the constructor.
  const CONSTRUCTOR_ANCHOR =
    `    this.effectivenessContainer = globalScene.add\n` +
    `      .container(0, 0)\n` +
    `      .setVisible(false)\n` +
    `      .setPositionRelative(this.type1Icon, 22, 4);\n` +
    `    this.add(this.effectivenessContainer);\n` +
    `\n` +
    `    this.effectivenessText = addTextObject(5, 4.5, "", TextStyle.BATTLE_INFO);\n` +
    `    this.effectivenessWindow = addWindow(0, 0, 0, 20, undefined, false, undefined, undefined, WindowVariant.XTHIN);\n` +
    `\n` +
    `    this.effectivenessContainer.add([this.effectivenessWindow, this.effectivenessText]);\n` +
    `  }`;
  requireAnchor(enemyInfoSrc, CONSTRUCTOR_ANCHOR, "effectiveness hint construction in enemy-battle-info.ts constructor");
  enemyInfoSrc = enemyInfoSrc.replace(
    CONSTRUCTOR_ANCHOR,
    `    this.effectivenessContainer = globalScene.add\n` +
      `      .container(0, 0)\n` +
      `      .setVisible(false)\n` +
      `      .setPositionRelative(this.type1Icon, 22, 4);\n` +
      `    this.add(this.effectivenessContainer);\n` +
      `\n` +
      `    this.effectivenessText = addTextObject(5, 4.5, "", TextStyle.BATTLE_INFO);\n` +
      `    this.effectivenessWindow = addWindow(0, 0, 0, 20, undefined, false, undefined, undefined, WindowVariant.XTHIN);\n` +
      `\n` +
      `    this.effectivenessContainer.add([this.effectivenessWindow, this.effectivenessText]);\n` +
      `\n` +
      `    // Offline: damage-range preview, positioned just below the effectiveness hint.\n` +
      `    this.damageRangeContainer = globalScene.add\n` +
      `      .container(0, 0)\n` +
      `      .setVisible(false)\n` +
      `      .setPositionRelative(this.type1Icon, 22, 14);\n` +
      `    this.add(this.damageRangeContainer);\n` +
      `\n` +
      `    this.damageRangeText = addTextObject(5, 4.5, "", TextStyle.BATTLE_INFO);\n` +
      `    this.damageRangeWindow = addWindow(0, 0, 0, 20, undefined, false, undefined, undefined, WindowVariant.XTHIN);\n` +
      `\n` +
      `    this.damageRangeContainer.add([this.damageRangeWindow, this.damageRangeText]);\n` +
      `\n` +
      `    // Offline: enemy HP% preview, positioned near the HP bar.\n` +
      `    this.hpPercentText = addTextObject(0, 0, "", TextStyle.BATTLE_INFO)\n` +
      `      .setVisible(false)\n` +
      `      .setPositionRelative(this.hpBar, 0, 10);\n` +
      `    this.add(this.hpPercentText);\n` +
      `  }`,
  );

  // 3d. New updateDamageRange() method, right after the existing updateEffectiveness().
  const UPDATE_EFFECTIVENESS_ANCHOR =
    `  updateEffectiveness(effectiveness?: string) {\n` +
    `    this.currentEffectiveness = effectiveness;\n` +
    `\n` +
    `    if (globalScene.typeHints === TypeHints.OFF || effectiveness === undefined || this.flyoutMenu.flyoutVisible) {\n` +
    `      this.effectivenessContainer.setVisible(false);\n` +
    `      return;\n` +
    `    }\n` +
    `\n` +
    `    this.effectivenessText.setText(effectiveness);\n` +
    `    this.effectivenessWindow.width = 10 + this.effectivenessText.displayWidth;\n` +
    `    this.effectivenessContainer.setVisible(true);\n` +
    `  }`;
  requireAnchor(enemyInfoSrc, UPDATE_EFFECTIVENESS_ANCHOR, "updateEffectiveness() method in enemy-battle-info.ts");
  enemyInfoSrc = enemyInfoSrc.replace(
    UPDATE_EFFECTIVENESS_ANCHOR,
    `${UPDATE_EFFECTIVENESS_ANCHOR}\n` +
      `\n` +
      `  /**\n` +
      `   * Offline: show or hide the damage-range/KO-label preview.\n` +
      `   * Passing undefined hides it (also hidden while the flyout menu covers this area).\n` +
      `   */\n` +
      `  updateDamageRange(text?: string): void {\n` +
      `    if (text === undefined || this.flyoutMenu.flyoutVisible) {\n` +
      `      this.damageRangeContainer.setVisible(false);\n` +
      `      return;\n` +
      `    }\n` +
      `\n` +
      `    this.damageRangeText.setText(text);\n` +
      `    this.damageRangeWindow.width = 10 + this.damageRangeText.displayWidth;\n` +
      `    this.damageRangeContainer.setVisible(true);\n` +
      `  }\n` +
      `\n` +
      `  /** Offline: refreshes the enemy HP% preview text, gated by its own setting. */\n` +
      `  private updateHpPercentText(pokemon: EnemyPokemon): void {\n` +
      `    if (!isEnemyHpPercentEnabled()) {\n` +
      `      this.hpPercentText.setVisible(false);\n` +
      `      return;\n` +
      `    }\n` +
      `    this.hpPercentText.setPositionRelative(this.hpBar, 0, 10);\n` +
      `    this.hpPercentText.setText(computeHpPercentText(pokemon)).setVisible(true);\n` +
      `  }`,
  );

  // 3e. Hook the HP% refresh into the existing updatePokemonHp() override.
  const UPDATE_HP_ANCHOR =
    `  protected override updatePokemonHp(\n` +
    `    pokemon: EnemyPokemon,\n` +
    `    resolve: (r: void | PromiseLike<void>) => void,\n` +
    `    instant?: boolean,\n` +
    `  ): void {\n` +
    `    super.updatePokemonHp(pokemon, resolve, instant);\n` +
    `    this.lastHp = pokemon.hp;\n` +
    `  }`;
  requireAnchor(enemyInfoSrc, UPDATE_HP_ANCHOR, "updatePokemonHp() override in enemy-battle-info.ts");
  enemyInfoSrc = enemyInfoSrc.replace(
    UPDATE_HP_ANCHOR,
    `  protected override updatePokemonHp(\n` +
      `    pokemon: EnemyPokemon,\n` +
      `    resolve: (r: void | PromiseLike<void>) => void,\n` +
      `    instant?: boolean,\n` +
      `  ): void {\n` +
      `    super.updatePokemonHp(pokemon, resolve, instant);\n` +
      `    this.lastHp = pokemon.hp;\n` +
      `    this.updateHpPercentText(pokemon);\n` +
      `  }`,
  );

  // 3f. Hook the HP% refresh into updateBossSegments() too, so the shields-remaining
  //     count updates the instant a segment breaks (not just on HP tween ticks).
  const BOSS_SEGMENTS_ANCHOR =
    `    this.bossSegments = boss ? pokemon.bossSegments : 0;\n` + `    this.updateBossSegmentDividers(pokemon);\n` + `  }`;
  requireAnchor(enemyInfoSrc, BOSS_SEGMENTS_ANCHOR, "end of updateBossSegments() in enemy-battle-info.ts");
  enemyInfoSrc = enemyInfoSrc.replace(
    BOSS_SEGMENTS_ANCHOR,
    `    this.bossSegments = boss ? pokemon.bossSegments : 0;\n` +
      `    this.updateBossSegmentDividers(pokemon);\n` +
      `    this.updateHpPercentText(pokemon);\n` +
      `  }`,
  );

  writeFile(ENEMY_INFO_PATH, enemyInfoSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 4: src/field/pokemon.ts
// ─────────────────────────────────────────────────────────────────────────────

const POKEMON_PATH = path.join("pokerogue-src", "src", "field", "pokemon.ts");
let pokemonSrc = readFile(POKEMON_PATH);

if (pokemonSrc.includes("updateDamageRange")) {
  console.log("SKIP pokemon.ts — damage preview forwarding method already present");
} else {
  // EnemyPokemon.updateDamageRange() forwards to battleInfo, mirroring the
  // existing updateEffectiveness() forwarding method it sits next to. Without
  // this, fight-ui-handler.ts's `enemy.updateDamageRange(...)` call (enemy is
  // the EnemyPokemon field object, not its battleInfo) throws
  // "updateDamageRange is not a function" at runtime.
  const UPDATE_EFFECTIVENESS_FWD_ANCHOR =
    `  /**\n` +
    `   * Show or hide the type effectiveness multiplier window\n` +
    `   * Passing undefined will hide the window\n` +
    `   */\n` +
    `  public updateEffectiveness(effectiveness?: string) {\n` +
    `    this.battleInfo.updateEffectiveness(effectiveness);\n` +
    `  }`;
  requireAnchor(pokemonSrc, UPDATE_EFFECTIVENESS_FWD_ANCHOR, "updateEffectiveness() forwarding method in pokemon.ts");
  pokemonSrc = pokemonSrc.replace(
    UPDATE_EFFECTIVENESS_FWD_ANCHOR,
    `${UPDATE_EFFECTIVENESS_FWD_ANCHOR}\n` +
      `\n` +
      `  /**\n` +
      `   * Offline: show or hide the damage-range/KO-label preview window.\n` +
      `   * Passing undefined will hide the window.\n` +
      `   */\n` +
      `  public updateDamageRange(text?: string) {\n` +
      `    this.battleInfo.updateDamageRange(text);\n` +
      `  }`,
  );

  writeFile(POKEMON_PATH, pokemonSrc);
}

console.log("Damage preview applied successfully.");
