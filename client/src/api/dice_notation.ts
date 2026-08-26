/**
 * Client-side port of the authoritative dice grammar in
 * crates/vtt-core/src/dice.rs (`DiceEngine::roll_expression`).
 *
 * PURPOSE AND HONESTY BOUNDARY: this module exists ONLY so the presentation
 * client can offer ad-hoc, free-form dice rolls ("roll me 2d20kh1+1d4") that
 * gameplay flows don't cover. Those rolls are LOCAL THEATER — they are never
 * sent to the Rust rules engine, never enter the audit ledger, and never gate
 * any rules decision. Every surface built on this module MUST label results
 * "local roll — not sent to the engine". Authoritative rolls (attacks,
 * checks, spells, macros) keep resolving through the gateway/engine path.
 *
 * Mirrored grammar (kept deliberately in lockstep with the Rust doc comment):
 *   expression := ['+' | '-'] term (('+' | '-') term)*
 *   term       := NdX [suffixes] | dX [suffixes] | integer
 *                 (N in 1..=1000, X in 2..=1000)
 *   suffixes   := keep? reroll? explode?      (each at most once; any order)
 *   keep       := ('kh' | 'kl') [N]           (defaults to 1; N <= dice count)
 *   reroll     := 'ro' ('<' | '>') T          (T within the die's range; ONE
 *                                              replacement roll, second value
 *                                              stands unconditionally)
 *   explode    := '!'                         (max face grants one bonus roll,
 *                                              chaining up to 10 times)
 *
 * Whitespace is tolerated between tokens. Total values actually rolled across
 * the whole expression are capped at 2000 (declared dice + rerolls + keeps +
 * explosion extras), matching the Rust cap. Deliberately unsupported, exactly
 * like the engine: infinite rerolls, ro=N thresholds, per-die arithmetic,
 * target success counts, FATE dice, parenthesised groups.
 */

/* ------------------------------------------------------------------ limits */

export const MAX_DICE_PER_EXPRESSION = 2000;
export const MAX_DICE_COUNT = 1000;
export const MIN_DIE_SIDES = 2;
export const MAX_DIE_SIDES = 1000;
export const MAX_EXPLOSIONS_PER_DIE = 10;

/* --------------------------------------------------------------------- rng */

/** Draws one uniform integer in 1..=sides. */
export type Rng = (sides: number) => number;

/** Cryptographically-random per-roll seed (crypto.getRandomValues). */
export function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}

/**
 * Deterministic mulberry32 die roller. Same seed -> same sequence of die
 * values for the same expression, which is what makes the Vitest semantics
 * tests and bug reports reproducible. NOT the engine's ChaCha StdRng — this
 * stream is only used for local theater rolls, so cross-implementation replay
 * parity is explicitly not a goal.
 */
export function makeSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e37_79b9; // mulberry32 hates an all-zero state
  return (sides: number): number => {
    state = (state + 0x6d2b_79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor(((t ^ (t >>> 14)) >>> 0) / 4294967296 * sides) + 1;
  };
}

/* -------------------------------------------------------------- parse tree */

export type KeepMode = { highest: boolean; n: number };
export type RerollMode = { comparator: '<' | '>'; threshold: number };

export interface ParsedTerm {
  /** Dice count, or the constant value when `sides` is null. */
  count: number;
  sides: number | null;
  /** Leading '+'/'-' of the term. Mirrors the Rust term_sign: applied to
   * constant terms only — dice terms always contribute positively, exactly
   * like the engine ("2d10-1d4" ADDS the d4 result and subtracts nothing;
   * subtraction of dice pools is deliberately unsupported there too). */
  sign: 1 | -1;
  keep: KeepMode | null;
  rerollOnce: RerollMode | null;
  explode: boolean;
}

/**
 * Validates a dice expression against the mirrored grammar.
 * Returns null when valid, otherwise a human-readable hint suitable for
 * showing live under the input field.
 */
export function validateDiceExpression(expression: string): string | null {
  try {
    parseExpression(expression);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

class ParseError extends Error {}

function parseExpression(expression: string): ParsedTerm[] {
  const src = expression.trim();
  const p = { bytes: src, pos: 0 };
  const skipWs = (): void => {
    while (p.pos < p.bytes.length && /\s/.test(p.bytes[p.pos])) p.pos += 1;
  };
  const peek = (): string => {
    skipWs();
    if (p.pos >= p.bytes.length) throw new ParseError('unexpected end of dice expression');
    return p.bytes[p.pos];
  };
  const takeSign = (): number => {
    skipWs();
    const c = p.bytes[p.pos];
    if (c === '+') {
      p.pos += 1;
      return 1;
    }
    if (c === '-') {
      p.pos += 1;
      return -1;
    }
    return 1;
  };
  const parseNumber = (what: string): number | null => {
    skipWs();
    const start = p.pos;
    let value = 0;
    while (p.pos < p.bytes.length && p.bytes[p.pos] >= '0' && p.bytes[p.pos] <= '9') {
      value = value * 10 + (p.bytes.charCodeAt(p.pos) - 48);
      if (value > 1_000_000_000) throw new ParseError(`${what} is too large`);
      p.pos += 1;
    }
    return p.pos === start ? null : value;
  };

  skipWs();
  if (p.pos >= p.bytes.length) throw new ParseError(`Empty dice expression: "${expression}"`);
  // Optional leading sign — captured here and used AS the first term's sign,
  // mirroring the Rust `leading_sign` (consuming it twice would flip "-5").
  let leadingSign: 1 | -1 = takeSign() === -1 ? -1 : 1;

  const terms: ParsedTerm[] = [];
  let firstTerm = true;
  for (;;) {
    let termSign: 1 | -1;
    if (firstTerm) {
      termSign = leadingSign;
    } else {
      const c = peek();
      if (c !== '+' && c !== '-') {
        throw new ParseError(
          `Expected '+' or '-' at position ${p.pos} in dice expression '${expression}', found '${c}'`
        );
      }
      termSign = takeSign() === -1 ? -1 : 1;
    }
    firstTerm = false;

    // ---- term ----
    const countRaw = parseNumber('dice count');
    skipWs();
    const c = p.bytes[p.pos];
    if (c === 'd' || c === 'D') {
      p.pos += 1;
      const sidesRaw = parseNumber('die size');
      if (sidesRaw === null) throw new ParseError("missing die size after 'd'");
      const count = countRaw ?? 1; // bare "dX" means one die
      if (count === 0 || count > MAX_DICE_COUNT) {
        throw new ParseError(`Dice count ${count} out of range (1-${MAX_DICE_COUNT})`);
      }
      if (sidesRaw < MIN_DIE_SIDES || sidesRaw > MAX_DIE_SIDES) {
        throw new ParseError(`Die size ${sidesRaw} out of range (${MIN_DIE_SIDES}-${MAX_DIE_SIDES})`);
      }
      const term: ParsedTerm = {
        count,
        sides: sidesRaw,
        sign: termSign as 1 | -1,
        keep: null,
        rerollOnce: null,
        explode: false,
      };
      // ---- suffixes: keep? reroll? explode?, each at most once ----
      for (;;) {
        skipWs();
        const s = p.bytes[p.pos];
        if (s === 'k' || s === 'K') {
          if (term.keep) throw new ParseError("keep suffix ('kh'/'kl') may only appear once per dice term");
          const h = p.bytes[p.pos + 1]?.toLowerCase();
          if (h !== 'h' && h !== 'l') break; // not a keep suffix; leave for boundary check
          p.pos += 2;
          const n = parseNumber('keep count') ?? 1;
          if (n > MAX_DICE_COUNT) {
            throw new ParseError(`Keep count ${n} out of range (1-${MAX_DICE_COUNT})`);
          }
          term.keep = { highest: h === 'h', n };
        } else if ((s === 'r' || s === 'R') && p.bytes[p.pos + 1]?.toLowerCase() === 'o') {
          if (term.rerollOnce) {
            throw new ParseError("reroll suffix ('ro') may only appear once per dice term");
          }
          p.pos += 2;
          const cmp = p.bytes[p.pos];
          if (cmp !== '<' && cmp !== '>') {
            throw new ParseError("reroll-once requires a '<' or '>' comparator (e.g. 'ro<3')");
          }
          p.pos += 1;
          const threshold = parseNumber('reroll threshold');
          if (threshold === null) throw new ParseError('missing reroll threshold');
          if (threshold > MAX_DIE_SIDES) {
            throw new ParseError('Reroll threshold outside plausible die range');
          }
          term.rerollOnce = { comparator: cmp, threshold };
        } else if (s === '!') {
          if (term.explode) throw new ParseError("explode suffix ('!') may only appear once per dice term");
          term.explode = true;
          p.pos += 1;
        } else {
          break;
        }
      }
      terms.push(term);
    } else {
      if (countRaw === null) throw new ParseError('expected dice notation or a number');
      if (countRaw > 0x7fffffff) throw new ParseError(`Constant ${countRaw} out of range`);
      terms.push({
        count: countRaw,
        sides: null,
        sign: termSign as 1 | -1,
        keep: null,
        rerollOnce: null,
        explode: false,
      });
    }

    skipWs();
    if (p.pos >= p.bytes.length) break;
  }
  return terms;
}

/* --------------------------------------------------------------- evaluation */

/** One physical die's fate, for the per-die display in the roller panel. */
export interface RolledDie {
  /** Final standing value (the reroll replacement when a reroll happened). */
  value: number;
  kept: boolean;
  /** The discarded first value, when the reroll-once threshold fired. */
  rerolledFrom?: number;
  /** Bonus rolls granted by '!', chained in draw order. */
  explodedTo: number[];
}

export interface RolledTerm {
  /** Canonical rendering of the term, e.g. "2d20kh1" or "+3". */
  label: string;
  sides: number | null;
  /** Per-die breakdown; empty for constant terms. */
  dice: RolledDie[];
  /** Signed constant contribution (0 for dice terms). */
  constant: number;
}

export interface LocalRollResult {
  expression: string;
  terms: RolledTerm[];
  /** All kept values in draw order, including explosion extras. */
  rolls: number[];
  /** Values discarded by rerolls and keeps, in draw order. */
  dropped: number[];
  modifier: number;
  total: number;
  /** True only when the whole expression resolves to exactly one d20. */
  isNatural20: boolean;
  isNatural1: boolean;
}

/**
 * Evaluates a validated expression locally. Draw-order contract mirrors the
 * Rust resolver: per die — initial roll, then ONE reroll replacement if the
 * threshold failed, then (after all dice) explosion chains in die order.
 * Keeps apply AFTER explosions so a dropped die's explosion still lands.
 *
 * @param expression dice notation, validated first (throws on bad grammar)
 * @param rng         die source; defaults to a fresh crypto-seeded stream
 */
export function evaluateDiceExpression(expression: string, rng: Rng = makeSeededRng(randomSeed())): LocalRollResult {
  const terms = parseExpression(expression);

  const rolledTerms: RolledTerm[] = [];
  const rolls: number[] = [];
  const dropped: number[] = [];
  let modifier = 0;
  let totalRolled = 0;

  for (const term of terms) {
    if (term.sides === null) {
      modifier += term.sign * term.count;
      rolledTerms.push({
        label: `${term.sign < 0 ? '-' : '+'}${term.count}`,
        sides: null,
        dice: [],
        constant: term.sign * term.count,
      });
      continue;
    }

    totalRolled += term.count;
    if (totalRolled > MAX_DICE_PER_EXPRESSION) {
      throw new ParseError(
        `Dice expression '${expression}' exceeds cap of ${MAX_DICE_PER_EXPRESSION} total dice`
      );
    }

    const keepN = term.keep ? term.keep.n : null;
    if (keepN !== null && (keepN === 0 || keepN > term.count)) {
      throw new ParseError(`Keep count ${keepN} out of range (1-${term.count} dice)`);
    }

    const dice: RolledDie[] = [];
    for (let i = 0; i < term.count; i += 1) {
      let value = rng(term.sides);
      let rerolledFrom: number | undefined;
      const rr = term.rerollOnce;
      if (rr) {
        if (rr.threshold < 1 || rr.threshold > term.sides) {
          throw new ParseError(`Reroll threshold ${rr.threshold} out of range for 'd${term.sides}' (1-${term.sides})`);
        }
        const fails =
          rr.comparator === '<' ? value < rr.threshold : value > rr.threshold;
        if (fails) {
          rerolledFrom = value;
          value = rng(term.sides); // ONCE — the second value stands even if it fails too
        }
      }
      const die: RolledDie = { value, kept: true, rerolledFrom, explodedTo: [] };
      if (rerolledFrom !== undefined) dropped.push(rerolledFrom);

      if (term.explode) {
        let current = value;
        while (current === term.sides && die.explodedTo.length < MAX_EXPLOSIONS_PER_DIE) {
          current = rng(term.sides);
          die.explodedTo.push(current);
        }
      }
      dice.push(die);
    }
    totalRolled += dice.reduce((acc, d) => acc + d.explodedTo.length + (d.rerolledFrom !== undefined ? 1 : 0), 0);
    if (totalRolled > MAX_DICE_PER_EXPRESSION) {
      throw new ParseError(
        `Dice expression '${expression}' exceeds cap of ${MAX_DICE_PER_EXPRESSION} total dice`
      );
    }

    // Keep AFTER explosions resolve (total-preserving semantics, like the
    // engine). Sort by value (desc for kh, asc for kl) with a stable tie-break
    // on original index, matching the Rust `then(a.cmp(&b))`.
    const keepSet = new Set<number>();
    if (term.keep) {
      const highest = term.keep.highest;
      const order = dice.map((_, idx) => idx);
      order.sort((a, b) => {
        const primary = highest ? dice[b].value - dice[a].value : dice[a].value - dice[b].value;
        return primary !== 0 ? primary : a - b;
      });
      for (const idx of order.slice(0, term.keep.n)) keepSet.add(idx);
    }

    const keptValues: number[] = [];
    const keptIndices: number[] = [];
    dice.forEach((die, idx) => {
      if (!term.keep || keepSet.has(idx)) {
        keptValues.push(die.value);
        keptIndices.push(idx);
      } else {
        dropped.push(die.value);
        die.kept = false;
      }
    });

    // Explosion extras append after kept dice, in die order, when the die was
    // kept OR the pool has no keep at all (mirrors the Rust filter).
    for (let idx = 0; idx < dice.length; idx += 1) {
      const die = dice[idx];
      if ((!term.keep || keptIndices.includes(idx) || die.explodedTo.length > 0) && die.explodedTo.length) {
        keptValues.push(...die.explodedTo);
      }
    }

    rolls.push(...keptValues);
    rolledTerms.push({
      label: renderTerm(term),
      sides: term.sides,
      dice,
      constant: 0,
    });
  }

  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + modifier;

  // Natural flags: exactly one dice term, resolved to exactly one kept die
  // with NO explosion extras ("1d20", "2d20kh1", "2d20kl1") — matching the
  // Rust `single_d20_kept` contract (extras or extra kept dice void it).
  const diceTerms = rolledTerms.filter((t) => t.sides !== null);
  let isNatural20 = false;
  let isNatural1 = false;
  if (diceTerms.length === 1 && rolls.length === 1) {
    const only = diceTerms[0];
    const hasExtras = only.dice.some((d) => d.explodedTo.length > 0);
    if (only.sides === 20 && !hasExtras) {
      isNatural20 = rolls[0] === 20;
      isNatural1 = rolls[0] === 1;
    }
  }

  // Back-compat shape: a bare constant keeps the historical rolls/modifier split.
  if (rolls.length === 0 && rolledTerms.every((t) => t.sides === null)) {
    rolls.push(modifier);
    return {
      expression,
      terms: rolledTerms,
      rolls,
      dropped,
      modifier: 0,
      total,
      isNatural20: false,
      isNatural1: false,
    };
  }

  return {
    expression,
    terms: rolledTerms,
    rolls,
    dropped,
    modifier,
    total,
    isNatural20,
    isNatural1,
  };
}

function renderTerm(term: ParsedTerm): string {
  if (term.sides === null) return `${term.count}`;
  let out = `${term.count}d${term.sides}`;
  if (term.keep) out += `k${term.keep.highest ? 'h' : 'l'}${term.keep.n}`;
  if (term.rerollOnce) out += `ro${term.rerollOnce.comparator}${term.rerollOnce.threshold}`;
  if (term.explode) out += '!';
  return out;
}
