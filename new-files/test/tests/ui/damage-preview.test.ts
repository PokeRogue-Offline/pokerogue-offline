import { allMoves } from "#data/data-lists";
import { AbilityId } from "#enums/ability-id";
import { GameModes } from "#enums/game-modes";
import { HitResult } from "#enums/hit-result";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { computeDamageRangeText, computeHpPercentText } from "#ui/damage-preview";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the fight-menu damage-range/HP% preview.
 *
 * These tests trust the engine's own damage formula and boss-segment-clamp
 * function (both already covered by their own test suites, e.g.
 * `test/tests/battle/damage-calculation.test.ts` and
 * `test/tests/pokemon/boss-pokemon.test.ts`) and instead stub
 * `EnemyPokemon.getAttackDamage()`'s return value directly, so each case can
 * assert this module's own min/max-roll, boss-clamp, and KO-label decision
 * logic against hand-computed expected output.
 */
describe("UI - Damage Preview", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .battleStyle("single")
      .enemySpecies(SpeciesId.RATTATA)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .enemyLevel(50)
      .startingLevel(50)
      .criticalHits(false)
      .moveset([MoveId.TACKLE, MoveId.SEISMIC_TOSS, MoveId.FISSURE, MoveId.BULLET_SEED, MoveId.GROWL]);
  });

  describe("computeDamageRangeText - non-boss", () => {
    it("shows a plain min%-max% range when no KO is guaranteed", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(150);
      defender.hp = 150;
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 54 });

      // minRaw = floor(54 * 0.85) = 45 -> 30%, maxRaw = 54 -> 36%
      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.TACKLE])).toBe("30%-36%");
    });

    it("labels an OHKO when even the minimum roll would faint the target", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(150);
      defender.hp = 50;
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 100 });

      // minRaw = floor(100 * 0.85) = 85 >= hp(50)
      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.TACKLE])).toBe("OHKO");
    });

    it("labels a 2HKO when the minimum roll needs exactly two hits", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(150);
      defender.hp = 90;
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 60 });

      // minRaw = floor(60 * 0.85) = 51; 51 < 90 (not 1HKO), 51*2 = 102 >= 90 (2HKO)
      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.TACKLE])).toBe("2HKO");
    });

    it("does not label a KO when neither the min roll nor double the min roll would faint the target", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(500);
      defender.hp = 500;
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 60 });

      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.TACKLE])).toBe("9%-12%");
    });
  });

  describe("computeDamageRangeText - boss shields", () => {
    it("passes damage through unclamped when it doesn't reach the segment boundary", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(200);
      defender.hp = 200;
      defender.bossSegments = 2;
      defender.bossSegmentIndex = 1;
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 60 });

      // minRaw = floor(60*0.85) = 51; neither 51 nor 60 reaches the 100 HP segment boundary
      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.TACKLE])).toBe("26%-30%");
    });

    it("shows 'Breaks Shield' (not a KO label) when only the max roll breaks the shield", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(200);
      defender.hp = 200;
      defender.bossSegments = 2;
      defender.bossSegmentIndex = 1;
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 110 });

      // minRaw = floor(110*0.85) = 93 -> doesn't reach the 100 HP boundary, so hit 1's
      // worst case is proven not to break the shield -> a plain range, not "Breaks Shield".
      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.TACKLE])).toBe("47%-50%");
    });

    it("discards overkill and shows 'Breaks Shield' when the min roll is guaranteed to break at least one segment", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(300);
      defender.hp = 300;
      defender.bossSegments = 3;
      defender.bossSegmentIndex = 2;
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 500 });

      // minRaw = floor(500*0.85) = 425, enough to bypass one extra segment (log2(325/100)=1 -> floor 1),
      // guaranteeing a break even on the worst roll - no KO label, even though the max
      // roll (500) would in fact drain the boss to 0.
      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.TACKLE])).toBe("Breaks Shield");
    });

    it("labels an OHKO against a boss when the clamped min roll still drains all remaining HP", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(200);
      defender.hp = 100;
      defender.bossSegments = 2;
      defender.bossSegmentIndex = 0; // last, unshielded segment - no clamp applies
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 200 });

      // minRaw = floor(200*0.85) = 170 >= hp(100)
      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.TACKLE])).toBe("OHKO");
    });
  });

  describe("computeDamageRangeText - classic final boss (Eternatus) pre-Eternamax floor", () => {
    it("never claims a guaranteed KO while the extra hp-1 floor is active", async () => {
      game.override.startingWave(200).startingBiome(0).criticalHits(false).startingLevel(10000);
      await game.runToFinalBossEncounter([SpeciesId.BIDOOF], GameModes.CLASSIC);

      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();
      expect(defender.species.speciesId).toBe(SpeciesId.ETERNATUS);
      expect(defender.formIndex).toBe(0);

      vi.spyOn(defender, "getMaxHp").mockReturnValue(1000);
      defender.hp = 10;
      defender.bossSegmentIndex = 0;
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({
        cancelled: false,
        result: HitResult.EFFECTIVE,
        damage: 100000,
      });

      const text = computeDamageRangeText(attacker, defender, allMoves[MoveId.TACKLE]);
      expect(text).not.toBe("OHKO");
      expect(text).not.toBe("2HKO");
    });
  });

  describe("computeDamageRangeText - OHKO, fixed-damage, multi-hit, and status moves", () => {
    it("omits an OHKO label against a boss (boss immunity)", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();
      defender.bossSegments = 2;
      defender.bossSegmentIndex = 1;

      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.FISSURE])).toBeUndefined();
    });

    it("omits an OHKO label when the user is under-leveled", async () => {
      game.override.startingLevel(1).enemyLevel(100);
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      expect(attacker.level).toBeLessThan(defender.level);
      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.FISSURE])).toBeUndefined();
    });

    it("shows an exact single percentage (not a range) for a fixed-damage move", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(1000);
      defender.hp = 1000;
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 100 });

      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.SEISMIC_TOSS])).toBe("10%");
    });

    it("shows a hit-count qualifier and no KO label for a multi-hit move", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(10);
      defender.hp = 10;
      // Wildly overkill on a single hit - if a KO label leaked through here, it would be wrong.
      vi.spyOn(defender, "getAttackDamage").mockReturnValue({ cancelled: false, result: HitResult.EFFECTIVE, damage: 1000 });

      const text = computeDamageRangeText(attacker, defender, allMoves[MoveId.BULLET_SEED]);
      expect(text).toContain("×2-5 hits");
      expect(text).not.toContain("Guaranteed");
    });

    it("shows nothing for a status move", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const attacker = game.field.getPlayerPokemon();
      const defender = game.field.getEnemyPokemon();

      expect(computeDamageRangeText(attacker, defender, allMoves[MoveId.GROWL])).toBeUndefined();
    });
  });

  describe("computeHpPercentText", () => {
    it("shows a plain percentage for a non-boss enemy", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(100);
      defender.hp = 63;

      expect(computeHpPercentText(defender)).toBe("63%");
    });

    it("appends the shields-remaining count for a boss with shields left", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(300);
      defender.hp = 210;
      defender.bossSegments = 3;
      defender.bossSegmentIndex = 2;

      expect(computeHpPercentText(defender)).toBe("70% (2 shields)");
    });

    it("shows no shields-remaining suffix once on the last, unshielded segment", async () => {
      await game.classicMode.startBattle(SpeciesId.MAGIKARP);
      const defender = game.field.getEnemyPokemon();

      vi.spyOn(defender, "getMaxHp").mockReturnValue(300);
      defender.hp = 90;
      defender.bossSegments = 3;
      defender.bossSegmentIndex = 0;

      expect(computeHpPercentText(defender)).toBe("30%");
    });
  });
});
