import { globalScene } from "#app/global-scene";
import { MoveCategory } from "#enums/move-category";
import { MultiHitType } from "#enums/multi-hit-type";
import type { EnemyPokemon, Pokemon } from "#field/pokemon";
import { PokemonMultiHitModifier } from "#modifiers/modifier";
import type { Move } from "#moves/move";
import { calculateBossSegmentDamage } from "#utils/damage";

/**
 * Damage-range / enemy-HP% preview, shown on the fight menu when the
 * "Damage Range" / "Enemy HP %" Offline settings are enabled.
 *
 * Reuses the game's own {@linkcode Pokemon.getAttackDamage} (always called
 * with `simulated: true`, exactly as the enemy AI's KO-check and the
 * existing type-effectiveness hint already do) and the game's own exported
 * {@linkcode calculateBossSegmentDamage} boss-shield clamp — no damage
 * formula is reimplemented here.
 *
 * `simulated: true` never rolls random variance (it's pinned to the top of
 * the 85-100% roll table), so the "min" endpoint of every range is an
 * approximation: `floor(maxRoll * 0.85)`. There is no engine API to request
 * an arbitrary roll, and calling with `simulated: false` would consume real
 * battle RNG and desync future rolls, so this is the closest obtainable
 * value without touching upstream's damage.ts.
 *
 * "Guaranteed" labels are decided off the minimum roll only, per Pokemon
 * damage-calculator convention. Crits are always excluded (`isCritical:
 * false`). Unrevealed enemy abilities are hidden via the same
 * `waveData.abilityRevealed` flag the existing effectiveness hint and enemy
 * AI already use - no new hidden information is exposed.
 *
 * Boss shield handling: a hit that's guaranteed to break a shield (even on
 * the worst/min roll) never shows a KO label, only "Breaks Shield" - the
 * stat boost a broken shield triggers is a weighted-random pick among the
 * boss's non-maxed stats (see EnemyPokemon.handleBossSegmentCleared), which
 * can't be predicted without consuming real RNG. A "Guaranteed 2HKO" is
 * therefore only ever claimed when the first hit's minimum roll is proven
 * not to break any shield, which keeps the defender's stats provably
 * unchanged between the two hits.
 */

const MIN_ROLL_MULTIPLIER = 0.85;

function getRawDamage(attacker: Pokemon, defender: EnemyPokemon, move: Move): number {
  return defender.getAttackDamage({
    source: attacker,
    move,
    isCritical: false,
    simulated: true,
    ignoreAbility: !defender.waveData.abilityRevealed,
    ignoreSourceAbility: false,
    ignoreAllyAbility: !defender.getAlly()?.waveData.abilityRevealed,
    ignoreSourceAllyAbility: false,
  }).damage;
}

function formatPercent(damage: number, maxHp: number): string {
  return `${Math.round((damage / maxHp) * 100)}%`;
}

function formatRange(minDamage: number, maxDamage: number, maxHp: number): string {
  const minPct = formatPercent(minDamage, maxHp);
  const maxPct = formatPercent(maxDamage, maxHp);
  return minPct === maxPct ? minPct : `${minPct}-${maxPct}`;
}

/** Mirrors the private `EnemyPokemon.getMinimumSegmentIndex()` - only the classic-mode final boss's pre-Eternamax phase locks its last segment. */
function getMinimumSegmentIndex(enemy: EnemyPokemon): number {
  return globalScene.currentBattle.isClassicFinalBoss && enemy.formIndex === 0 ? 1 : 0;
}

/** Mirrors the extra `damage = Math.min(damage, this.hp - 1)` floor in `EnemyPokemon.damage()` - the classic final boss can never be reduced below 1 HP before its phase-2 form change. */
function isClassicFinalBossPhaseOne(enemy: EnemyPokemon): boolean {
  return globalScene.currentBattle.isClassicFinalBoss && enemy.formIndex === 0 && enemy.bossSegmentIndex < 1;
}

interface BossHitChainResult {
  /** HP remaining after the chain stops (0 if it ended in a KO). */
  hpRemaining: number;
  /** Index of the hit that KO'd the target, if any. */
  koAtHit?: number;
  /** Whether a hit in the chain broke a shield before the chain could finish. */
  breaksShield?: true;
}

/**
 * Chains an ordered sequence of raw-damage hits (e.g. the internal strikes of
 * a single Multi-Lens-boosted move use) against a boss's current
 * segment/shield, stopping as soon as a hit would KO or break a shield - a
 * shield breaking mid-chain triggers an unpredictable (weighted-random) stat
 * boost that invalidates predicting any later hit in the same chain.
 */
function chainBossHits(enemy: EnemyPokemon, hitsRaw: number[], startHp: number): BossHitChainResult {
  const maxHp = enemy.getMaxHp();
  const segmentSize = maxHp / enemy.bossSegments;
  const minSegIdx = getMinimumSegmentIndex(enemy);
  const segIdx = enemy.bossSegmentIndex;

  let hp = startHp;
  for (let i = 0; i < hitsRaw.length; i++) {
    const finalBossCap = isClassicFinalBossPhaseOne(enemy) ? hp - 1 : hp;
    const [adjustedRaw, cleared] = calculateBossSegmentDamage(hitsRaw[i], hp, segmentSize, minSegIdx, segIdx);
    const adjusted = Math.min(adjustedRaw, finalBossCap);
    const hpBeforeHit = hp;
    hp = Math.max(hp - adjusted, 0);
    if (adjusted >= hpBeforeHit) {
      return { hpRemaining: 0, koAtHit: i };
    }
    if (cleared <= segIdx) {
      return { hpRemaining: hp, breaksShield: true };
    }
  }
  return { hpRemaining: hp };
}

/**
 * Computes the damage-range / KO-label text for one move use that deals the
 * given ordered min/max raw-damage hits (a single-element array for a normal
 * single-hit move, or `[first, rest, rest, ...]` for a Multi-Lens-boosted
 * move - see {@linkcode getRawDamagePerLensHit}).
 */
function formatMultiHit(defender: EnemyPokemon, minHits: number[], maxHits: number[]): string {
  const maxHp = defender.getMaxHp();
  const hp = defender.hp;

  if (!defender.isBoss()) {
    const minTotal = minHits.reduce((a, b) => a + b, 0);
    const maxTotal = maxHits.reduce((a, b) => a + b, 0);
    if (minTotal >= hp) {
      return "OHKO";
    }
    if (minTotal * 2 >= hp) {
      return "2HKO";
    }
    return formatRange(Math.min(minTotal, hp), Math.min(maxTotal, hp), maxHp);
  }

  const firstUseMin = chainBossHits(defender, minHits, hp);
  if (firstUseMin.koAtHit !== undefined) {
    return "OHKO";
  }
  // Guaranteed (worst-roll) shield break on any hit of this move use: a
  // weighted-random stat boost may follow, which can't be predicted without
  // consuming real RNG - show that instead of a KO label, per design.
  if (firstUseMin.breaksShield) {
    return "Breaks Shield";
  }

  const firstUseMax = chainBossHits(defender, maxHits, hp);
  const minDealt = hp - firstUseMin.hpRemaining;
  const maxDealt = hp - firstUseMax.hpRemaining;

  // No shield broke on this move use's minimum roll, so the defender's stats
  // are provably unchanged going into a second use next turn - safe to chain
  // the same min-roll hits again.
  const secondUse = chainBossHits(defender, minHits, firstUseMin.hpRemaining);
  if (secondUse.koAtHit !== undefined) {
    return "2HKO";
  }

  return formatRange(Math.min(minDealt, hp), Math.min(maxDealt, hp), maxHp);
}

/**
 * Returns the total number of strikes `move` will deal for `attacker` purely
 * from stacked Multi Lens (1 if no Multi Lens applies - Multi Lens and an
 * innate {@linkcode MultiHitAttr} are mutually exclusive, since
 * {@linkcode Move.canBeMultiStrikeEnhanced} already excludes `MultiHitAttr`
 * moves).
 */
function getMultiLensHitCount(attacker: Pokemon, move: Move): number {
  if (!move.canBeMultiStrikeEnhanced(attacker)) {
    return 1;
  }
  const stackCount =
    attacker
      .getHeldItems()
      .find(m => m instanceof PokemonMultiHitModifier)
      ?.getStackCount() ?? 0;
  return 1 + stackCount;
}

/**
 * Computes the raw damage of the first Multi-Lens hit and of every hit after
 * it (which all share the same flat 0.25x multiplier - see
 * {@linkcode PokemonMultiHitModifier.applyDamageModifier}) by temporarily
 * driving the attacker's `turnData` to the exact values the engine itself
 * would have mid-resolution, then restoring it - reusing the real modifier
 * logic instead of re-deriving the 0.75/0.5/0.25 multipliers here.
 */
function getRawDamagePerLensHit(
  attacker: Pokemon,
  defender: EnemyPokemon,
  move: Move,
  totalHits: number,
): { first: number; rest: number } {
  const { hitCount: origHitCount, hitsLeft: origHitsLeft } = attacker.turnData;
  try {
    attacker.turnData.hitCount = totalHits;
    attacker.turnData.hitsLeft = totalHits;
    const first = getRawDamage(attacker, defender, move);

    attacker.turnData.hitsLeft = totalHits - 1;
    const rest = totalHits > 1 ? getRawDamage(attacker, defender, move) : 0;

    return { first, rest };
  } finally {
    attacker.turnData.hitCount = origHitCount;
    attacker.turnData.hitsLeft = origHitsLeft;
  }
}

/**
 * Computes the damage-range / KO-label text for `move` used by `attacker`
 * against `defender`, or `undefined` if nothing should be shown (status
 * moves, moves with no fixed power, or an OHKO move that would fail/be
 * blocked).
 */
export function computeDamageRangeText(attacker: Pokemon, defender: EnemyPokemon, move: Move): string | undefined {
  if (move.hasAttr("OneHitKOAttr")) {
    if (defender.isBossImmune() || !move.applyConditions(attacker, defender, -1)) {
      return undefined;
    }
    return "OHKO";
  }

  if (move.hasAttr("FixedDamageAttr")) {
    const raw = getRawDamage(attacker, defender, move);
    return formatMultiHit(defender, [raw], [raw]);
  }

  if (move.power < 0 || move.category === MoveCategory.STATUS) {
    return undefined;
  }

  const lensHits = getMultiLensHitCount(attacker, move);
  if (lensHits > 1) {
    const { first, rest } = getRawDamagePerLensHit(attacker, defender, move, lensHits);
    const maxHits = [first, ...Array.from({ length: lensHits - 1 }, () => rest)];
    const minHits = maxHits.map(d => Math.floor(d * MIN_ROLL_MULTIPLIER));
    return formatMultiHit(defender, minHits, maxHits);
  }

  const maxRaw = getRawDamage(attacker, defender, move);
  const minRaw = Math.floor(maxRaw * MIN_ROLL_MULTIPLIER);

  const multiHitAttr = move.getAttrs("MultiHitAttr")[0];
  if (multiHitAttr) {
    const maxHp = defender.getMaxHp();
    let hitLabel: string;
    switch (multiHitAttr.getMultiHitType()) {
      case MultiHitType.TWO:
        hitLabel = "×2 hits";
        break;
      case MultiHitType.THREE:
        hitLabel = "×3 hits";
        break;
      case MultiHitType.TEN:
        hitLabel = "×10 hits";
        break;
      case MultiHitType.BEAT_UP:
        hitLabel = "×? hits";
        break;
      case MultiHitType.TWO_TO_FIVE:
      default:
        hitLabel = "×2-5 hits";
        break;
    }
    // Hit count (and, for TWO_TO_FIVE, which count occurs) is only resolved
    // via real RNG at move-use time - show the single-hit range with a hit
    // count qualifier and deliberately omit any KO label.
    return `${formatRange(Math.min(minRaw, defender.hp), Math.min(maxRaw, defender.hp), maxHp)} ${hitLabel}`;
  }

  return formatMultiHit(defender, [minRaw], [maxRaw]);
}

/**
 * Computes the enemy HP% text, e.g. `"63%"` or `"70% (2 shields)"` for a
 * boss. The percentage is always of the Pokemon's *total* max HP
 * (`Pokemon.getHpRatio()` - the same ratio the HP bar itself already uses),
 * so boss segments never need special-casing here. "Shields remaining" is
 * `bossSegmentIndex` directly - `0` once on the last, unshielded segment,
 * matching the exact condition `calculateBossSegmentDamage` uses to skip
 * clamping entirely.
 */
export function computeHpPercentText(pokemon: EnemyPokemon): string {
  const percent = Math.round(pokemon.getHpRatio(true) * 100);
  if (pokemon.isBoss() && pokemon.bossSegmentIndex > 0) {
    const shields = pokemon.bossSegmentIndex;
    return `${percent}% (${shields} shield${shields === 1 ? "" : "s"})`;
  }
  return `${percent}%`;
}
