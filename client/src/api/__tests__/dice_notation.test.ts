/**
 * Iteration 11 (Loop 3) — dice_notation.ts contracts.
 *
 * The module is a client-side port of crates/vtt-core/src/dice.rs grammar and
 * resolver semantics, used ONLY by the local-theater DiceRollerPanel. These
 * tests pin:
 *  - GRAMMAR: valid/invalid expressions, mirroring the engine's error bands
 *    (range caps, duplicate suffixes, missing comparators, boundary checks).
 *  - KEEP/REROLL/EXPLODE semantics against hand-computed cases with a fixed
 *    die sequence (draw-order contract: base -> reroll replacement ->
 *    explosion chain; keeps applied after explosions).
 *  - SEED DETERMINISM: same seed -> identical result; different seeds diverge;
 *    randomSeed() yields fresh crypto-backed values.
 *
 * Honesty invariant: nothing here touches the wire — these are pure functions
 * on a seeded RNG stream, which is exactly what makes them testable.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateDiceExpression,
  makeSeededRng,
  MAX_EXPLOSIONS_PER_DIE,
  randomSeed,
  validateDiceExpression,
  type Rng,
} from '../dice_notation';

/** Fixed-sequence RNG helper: cycles the supplied values per die draw. */
function seqRng(values: number[]): Rng & { draws: () => number } {
  let i = 0;
  const fn = ((sides: number) => values[i++ % values.length]) as Rng & { draws: () => number };
  fn.draws = () => i;
  return fn;
}

describe('grammar validation', () => {
  const valid = [
    'd20',
    '1d20',
    '2d20kh1',
    '2d20kl1',
    '4d6ro<3',
    '1d6!',
    '2d6+1d4+3',
    '4d8-2',
    '2d10-1d4',
    '-5',
    '+3',
    '8d6 + 4',
    '2D6KH2', // case-insensitive tokens
    '1000d2', // count cap boundary
    'd1000', // sides cap boundary
    'd2', // min sides
    '4d6ro>4!',
    '3d6!kh2ro<2', // suffixes in any order
  ];
  it.each(valid)('accepts %s', (expr) => {
    expect(validateDiceExpression(expr)).toBeNull();
  });

  const invalid: Array<[string, RegExp | string]> = [
    ['', /Empty dice expression/],
    ['   ', /Empty dice expression/],
    ['d', /missing die size/],
    ['d1', /out of range \(2-1000\)/], // min sides
    ['d1001', /out of range \(2-1000\)/], // max sides
    ['1001d6', /Dice count .* out of range \(1-1000\)/],
    ['0d6', /Dice count .* out of range/],
    // Grammar-valid but semantically dead: the engine checks keep-vs-count
    // range in resolve_dice_pool, so validation passes and EVALUATION throws.
    ['2d6kh0', 'EVAL'],
    ['2d6kh3', 'EVAL'],
    // Mirror note: like the Rust parser, "roro<" trips the comparator check
    // before the once-only reroll guard can fire.
    ['2d6roro<3', /requires a '<' or '>' comparator/],
    ['2d6khkh2', /keep suffix .* may only appear once/],
    ['2d6ro<2ro<3', /reroll suffix .* may only appear once/],
    ['2d6ro3', /requires a '<' or '>' comparator/],
    ['2d6ro<', /missing reroll threshold/],
    ['2d6ro<1001', /outside plausible die range/],
    ['1d6!!', /explode suffix .* may only appear once/],
    ['2d6+4x', /Expected '\+' or '-' at position/],
    // A doubled sign parses as an empty term: the engine's term parser
    // answers 'expected dice notation or a number'.
    ['2d6++3', /expected dice notation or a number/],
    ['$%^', /expected dice notation or a number/],
    ['(1d6)', /Expected '\+' or '-'|expected dice notation/],
    ['99999999999d6', /too large/],
  ];
  it.each(invalid)('rejects %s', (expr, pattern) => {
    if (pattern === 'EVAL') {
      expect(validateDiceExpression(expr)).toBeNull();
      expect(() => evaluateDiceExpression(expr, seqRng([1]))).toThrow(/Keep count .* out of range/);
    } else {
      expect(validateDiceExpression(expr)).toMatch(pattern);
    }
  });

});

describe('keep/reroll/explode semantics vs hand-computed cases', () => {
  it('sums plain dice plus modifier and reports kept rolls', () => {
    // 2d6 (3,4) + 1d4 (2) + 3 => total 12, modifier +3
    const r = evaluateDiceExpression('2d6+1d4+3', seqRng([3, 4, 2]));
    expect(r.rolls).toEqual([3, 4, 2]);
    expect(r.modifier).toBe(3);
    expect(r.total).toBe(12);
    expect(r.dropped).toEqual([]);
  });

  it('subtracts flat terms but ADDS dice terms, mirroring the engine', () => {
    // 4d8 (5,5,5,5) - 2 => 18
    const r = evaluateDiceExpression('4d8-2', seqRng([5]));
    expect(r.modifier).toBe(-2);
    expect(r.total).toBe(18);
    // The Rust resolver applies term signs to CONSTANTS only: "2d10-1d4"
    // keeps the d4's positive contribution (engine test asserts total in
    // [2-4, 20-2], i.e. sum + modifier with modifier = 0... actually
    // modifier stays 0 because -1d4 is a DICE term whose sign is ignored).
    const r2 = evaluateDiceExpression('2d10-1d4', seqRng([9, 9, 3]));
    expect(r2.modifier).toBe(0); // "-1d4" is a dice term — its sign is dropped
    expect(r2.rolls).toEqual([9, 9, 3]); // all three dice land positive
    expect(r2.total).toBe(21);
  });

  it('kh1 keeps the highest of two d20s and drops the rest', () => {
    // Rolls 7 then 15 -> keep highest = [15], dropped = [7]
    const r = evaluateDiceExpression('2d20kh1', seqRng([7, 15]));
    expect(r.rolls).toEqual([15]);
    expect(r.dropped).toEqual([7]);
    expect(r.total).toBe(15);
    expect(r.isNatural20).toBe(false);
    expect(r.isNatural1).toBe(false);
  });

  it('kl1 keeps the lowest of two d20s', () => {
    // Rolls 13 then 4 -> keep lowest = [4]
    const r = evaluateDiceExpression('2d20kl1', seqRng([13, 4]));
    expect(r.rolls).toEqual([4]);
    expect(r.dropped).toEqual([13]);
    expect(r.total).toBe(4);
  });

  it('flags natural 20 / natural 1 for a single resolved d20', () => {
    expect(evaluateDiceExpression('1d20', seqRng([20])).isNatural20).toBe(true);
    expect(evaluateDiceExpression('1d20+5', seqRng([1])).isNatural1).toBe(true);
    // A kept pool down to one die still carries the flags...
    expect(evaluateDiceExpression('2d20kh1', seqRng([11, 20])).isNatural20).toBe(true);
    expect(evaluateDiceExpression('2d20kl1', seqRng([1, 17])).isNatural1).toBe(true);
    // ...but multiple dice terms never do.
    const multi = evaluateDiceExpression('1d20+1d4', seqRng([20, 2]));
    expect(multi.isNatural20).toBe(false);
    // And neither does an exploding d20 (extras break the single-roll shape).
    const exploded = evaluateDiceExpression('1d20!', seqRng([20, 7]));
    expect(exploded.isNatural20).toBe(false);
  });

  it('rerolls ONCE when the threshold fails; second value stands even if it also fails', () => {
    // 4d6ro<3: d1 2(fail)->5, d2 1(fail)->6, d3 4(ok), d4 2(fail)->5
    const r = evaluateDiceExpression('4d6ro<3', seqRng([2, 5, 1, 6, 4, 2, 5]));
    expect(r.rolls).toEqual([5, 6, 4, 5]);
    expect(r.dropped).toEqual([2, 1, 2]);
    // Second value stands even when it fails too: 1(fail)->2 stands despite <3.
    const stubborn = evaluateDiceExpression('1d6ro<3', seqRng([1, 2]));
    expect(stubborn.rolls).toEqual([2]);
    expect(stubborn.dropped).toEqual([1]);
  });

  it('rerolls above thresholds symmetrically', () => {
    // 2d6ro>4 with faces 6,3: 6 fails (>4), replaced by 2 => kept [2,3]
    const r = evaluateDiceExpression('2d6ro>4', seqRng([6, 2, 3]));
    expect(r.rolls).toEqual([2, 3]);
    expect(r.dropped).toEqual([6]);
  });

  it('explodes on max face and chains up to the cap', () => {
    // 1d6! rolling a 6 grants one bonus roll (a 4): kept [6,4]
    const r = evaluateDiceExpression('1d6!', seqRng([6, 4]));
    expect(r.rolls).toEqual([6, 4]);
    expect(r.terms[0].dice[0].explodedTo).toEqual([4]);

    // Chain: every bonus roll is itself a 6, capped at MAX_EXPLOSIONS_PER_DIE.
    const chain = evaluateDiceExpression('1d6!', seqRng([6]));
    expect(chain.rolls.length).toBe(1 + MAX_EXPLOSIONS_PER_DIE);
    expect(chain.rolls.every((v) => v === 6)).toBe(true);
  });

  it('keeps apply AFTER explosions so a dropped die still explodes', () => {
    // 3d6kh1! with faces 6(bonus 5), 3, 6(bonus 2):
    // explosion extras exist for both sixes; keep picks die #1 (value 6).
    // Kept = [6] + its extra [5]; the other six's extra is NOT appended
    // because its die was dropped AND ... wait — the Rust filter appends
    // extras for any die that has them, kept or not. Mirror that here.
    const r = evaluateDiceExpression('3d6kh1!', seqRng([6, 5, 3, 6, 2]));
    // Draw order per die: d1=6 (extra 5), d2=3 (no explode), d3=6 (extra 2)
    expect(r.terms[0].dice[0].explodedTo).toEqual([5]);
    expect(r.terms[0].dice[2].explodedTo).toEqual([2]);
    expect(r.rolls).toContain(6);
    // Both sixes' extras land in the total (total-preserving semantics).
    expect(r.rolls).toEqual(expect.arrayContaining([5, 2]));
    expect(r.dropped).toContain(3);
  });

  it('rejects keep counts outside 1..=count at evaluation time', () => {
    expect(() => evaluateDiceExpression('2d6kh3', seqRng([1]))).toThrow(/Keep count 3 out of range/);
    expect(() => evaluateDiceExpression('2d6kh0', seqRng([1]))).toThrow(/Keep count 0 out of range/);
  });

  it('rejects reroll thresholds outside the die range at evaluation time', () => {
    expect(() => evaluateDiceExpression('1d6ro<0', seqRng([1]))).toThrow(/out of range for 'd6'/);
    expect(() => evaluateDiceExpression('1d6ro<7', seqRng([1]))).toThrow(/out of range for 'd6'/);
  });

  it('caps total rolled values across the whole expression at 2000', () => {
    // Per-term count is capped at 1000 by the grammar, so reach the global
    // cap through reroll/explode expansion: 1000d2! rolls 1000 base dice and,
    // with an always-exploding face, up to 10 extras each -> way past 2000.
    expect(() => evaluateDiceExpression('999d2!+999d2!', seqRng([2]))).toThrow(/exceeds cap of 2000/);
    // And a plain pool right under the cap evaluates fine.
    const ok = validateDiceExpression('1000d2');
    expect(ok).toBeNull();
    const res = evaluateDiceExpression('1000d2+900d2', seqRng([1]));
    expect(res.rolls.length).toBe(1900);
  });

  it('preserves the bare-constant back-compat shape', () => {
    const r = evaluateDiceExpression('-5', seqRng([]));
    expect(r.rolls).toEqual([-5]);
    expect(r.modifier).toBe(0);
    expect(r.total).toBe(-5);
    const p = evaluateDiceExpression('+3', seqRng([]));
    expect(p.total).toBe(3);
  });

  it('reports per-die breakdown with rerolledFrom provenance', () => {
    const r = evaluateDiceExpression('2d6ro<3', seqRng([1, 4, 5]));
    expect(r.terms[0].dice[0]).toMatchObject({ value: 4, kept: true, rerolledFrom: 1, explodedTo: [] });
    expect(r.terms[0].dice[1]).toMatchObject({ value: 5, kept: true });
    expect(r.terms[0].dice[1].rerolledFrom).toBeUndefined();
  });
});

describe('seed determinism', () => {
  it('same seed reproduces the identical roll for the same expression', () => {
    const a = evaluateDiceExpression('8d6+4', makeSeededRng(1337));
    const b = evaluateDiceExpression('8d6+4', makeSeededRng(1337));
    expect(a.rolls).toEqual(b.rolls);
    expect(a.dropped).toEqual(b.dropped);
    expect(a.total).toBe(b.total);
    expect(a.isNatural20).toBe(b.isNatural20);
  });

  it('different seeds diverge across a batch of rolls', () => {
    const totals = new Set<number>();
    for (let seed = 1; seed <= 40; seed += 1) {
      totals.add(evaluateDiceExpression('6d6', makeSeededRng(seed)).total);
    }
    // 36 possible sums; 40 distinct seeds must produce more than a handful.
    expect(totals.size).toBeGreaterThan(10);
  });

  it('stays within the legal die range for every draw', () => {
    for (const seed of [0, 1, 42, 1337, 0xffffffff]) {
      const rng = makeSeededRng(seed);
      for (const sides of [2, 4, 6, 8, 10, 12, 20, 100, 1000]) {
        const v = rng(sides);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(sides);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it('randomSeed() hands out distinct crypto-backed seeds', () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 50; i += 1) seeds.add(randomSeed());
    expect(seeds.size).toBeGreaterThan(45); // birthday-collision-safe margin
  });

  it('two default-rng rolls of the same expression differ (fresh entropy per roll)', () => {
    // Not a strict guarantee, but over many trials identical streams would be
    // astronomically unlikely if entropy were actually fresh per call.
    let differed = false;
    for (let i = 0; i < 25 && !differed; i += 1) {
      const a = evaluateDiceExpression('10d10');
      const b = evaluateDiceExpression('10d10');
      differed = a.rolls.some((v, idx) => v !== b.rolls[idx]);
    }
    expect(differed).toBe(true);
  });
});
