/**
 * modes.test.ts — the host's board is what the room plays, and all three of them
 * are real games.
 *
 * Two jobs, and the second is the one that took the work.
 *
 * The first is sync: a mode changes the grid AND the colour count, so if two
 * peers resolve it differently they generate different honeycombs from the same
 * seed — the same class of bug as the roster drift that put scores on the wrong
 * name. The mode travels frozen inside the round start; rematch.test.ts pins the
 * wire, and these pin the resolution.
 *
 * The second is that a mode has to CHANGE something. Two modes that differ only
 * in a number are one mode with a lie on the chip, and the only way to know which
 * you have is to play them — so these tests play them, a few hundred AI games a
 * piece, and assert on the shape of the result. This is also the viability gate:
 * the tide constants (game.ts) are functions of player count and were tuned on
 * the 9x9 alone, so a new board size is exactly where the snowball balance.test.ts
 * exists to catch could come back. It does not — but that is measured here, not
 * assumed, because on this game the plausible story has been wrong more often
 * than it has been right.
 *
 * Deterministic and seeded: no Math.random, same numbers on every run.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODE_LIST, MODES, modeOf, type Mode } from '../src/modes';
import { applyMove, chooseAiColor, generateBoard, scores, winners } from '../src/game';
import { SYMBOLS, TILE_COLORS } from '../src/render';

/** Seeded rng so the AI never varies run to run. */
function makeRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Shape {
  /** Mean moves in a finished game. */
  moves: number;
  /** Mean tiles taken per move, as a share of the whole board. */
  sharePerMove: number;
  /** Fraction of games the winner took by more than half the claimed board. */
  blowouts: number;
  /** Fraction of games won outright by the first seat. */
  firstSeatWins: number;
}

/** Play `n` seeded AI-vs-AI games of `m` and report the shape of the outcome. */
function shapeOf(m: Mode, players: number, n = 60): Shape {
  let moves = 0;
  let taken = 0;
  let blowouts = 0;
  let firstSeatWins = 0;
  for (let seed = 0; seed < n; seed++) {
    const rand = makeRand(seed + 1);
    let s = generateBoard(seed, { w: m.w, h: m.h, colors: m.colors, players });
    // Every seat plays the same AI, so any asymmetry in the result is the
    // BOARD's, not a handicap we handed one of them.
    let guard = 0;
    while (!s.finished && guard++ < 4000) {
      const r = applyMove(s, s.turn, chooseAiColor(s, s.turn, 'normal', rand));
      if (r.state === s) break; // no legal progress — never seen, but never hang
      taken += r.absorbed.length;
      s = r.state;
    }
    moves += s.turnNo;
    const sc = scores(s);
    const claimed = sc.reduce((a, b) => a + b, 0);
    const sorted = [...sc].sort((a, b) => b - a);
    if (claimed > 0 && (sorted[0] - sorted[1]) / claimed > 0.5) blowouts++;
    const w = winners(s);
    if (w.length === 1 && w[0] === 0) firstSeatWins++;
  }
  return {
    moves: moves / n,
    sharePerMove: taken / moves / (m.w * m.h),
    blowouts: blowouts / n,
    firstSeatWins: firstSeatWins / n,
  };
}

describe('modeOf', () => {
  it('resolves a known id', () => {
    expect(modeOf('skirmish').w).toBe(7);
    expect(modeOf('wilds').colors).toBe(7);
  });

  it('falls back rather than handing generateBoard an undefined size', () => {
    // A start from an older peer, a corrupted store, or a hand-edited message.
    // Without the fallback this reaches generateBoard as w: undefined, which
    // does not throw — it builds `new Array(NaN * NaN)` worth of nothing and the
    // board renders empty. A mismatched peer should play Bloom instead.
    for (const bad of [undefined, null, '', 'nope', 42, {}, ['wilds']]) {
      expect(modeOf(bad as unknown).id).toBe(DEFAULT_MODE);
      expect(Number.isInteger(modeOf(bad as unknown).w)).toBe(true);
      expect(Number.isInteger(modeOf(bad as unknown).h)).toBe(true);
    }
  });

  it('resolves a hostile id off the wire without inheriting from Object', () => {
    // MODES is an object literal, so 'constructor' / 'toString' are truthy on it.
    // Returning one of those as a Mode would put `undefined` in every field.
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(modeOf(bad).id).toBe(DEFAULT_MODE);
    }
  });
});

describe('the modes are actually different games', () => {
  it('offers a real spread of board and palette', () => {
    const areas = new Set(MODE_LIST.map((m) => m.w * m.h));
    const colors = new Set(MODE_LIST.map((m) => m.colors));
    expect(areas.size).toBe(MODE_LIST.length); // no two modes are the same board
    expect(colors.size).toBe(MODE_LIST.length);
  });

  it('only asks for colours the game can actually paint', () => {
    for (const m of MODE_LIST) {
      // Four seats each need a distinct starting colour (generateBoard's palette
      // shuffle), and there is no eighth colour-blind-safe tile colour to add.
      expect(m.colors, `${m.id} colours`).toBeGreaterThanOrEqual(4);
      expect(m.colors, `${m.id} colours`).toBeLessThanOrEqual(TILE_COLORS.length);
    }
  });

  it('can draw a symbol for every colour it can paint', () => {
    // Symbol mode is the colour-blind fallback, and render.ts reads it as
    // `SYMBOLS[col] ?? ''` — a colour past the end of this array draws an EMPTY
    // hex rather than throwing. Adding a tile colour without adding its glyph
    // therefore breaks the accessibility path silently, and only for the players
    // who cannot fall back on the colour. Wilds already spends all seven.
    expect(SYMBOLS.length).toBeGreaterThanOrEqual(TILE_COLORS.length);
    for (const [i, sym] of SYMBOLS.entries()) {
      expect(sym, `symbol ${i}`).toBeTruthy();
    }
  });

  it('builds the honeycomb its mode asks for', () => {
    for (const m of MODE_LIST) {
      const s = generateBoard(7, { w: m.w, h: m.h, colors: m.colors, players: 4 });
      expect(s.w).toBe(m.w);
      expect(s.h).toBe(m.h);
      expect(s.tile).toHaveLength(m.w * m.h);
      expect(Math.max(...s.tile)).toBeLessThan(m.colors);
      // All four seats got a colour of their own to start from.
      expect(new Set(s.color).size).toBe(4);
    }
  });

  it('makes a Skirmish move worth far more of the board than a Wilds move', () => {
    // The actual difference between the modes, and NOT the one I assumed when I
    // wrote them: a Wilds bloom is bigger in tiles (4.4 vs 3.3) because the board
    // is bigger. It is less than half as much of the GAME. That is why Skirmish
    // is a scrap and Wilds is positional, and if this ever stopped being true the
    // three chips would be three numbers.
    const skirmish = shapeOf(MODES.skirmish, 2);
    const wilds = shapeOf(MODES.wilds, 2);
    expect(skirmish.sharePerMove).toBeGreaterThan(wilds.sharePerMove * 1.8);
  });

  it('makes each mode a materially different length of game', () => {
    const moves = MODE_LIST.map((m) => shapeOf(m, 2).moves);
    // Measured 14.4 / 22.7 / 32.2. Ordered and well separated — a mode that is
    // 10% longer than its neighbour is not a mode.
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i], `${MODE_LIST[i].id} vs ${MODE_LIST[i - 1].id}`).toBeGreaterThan(
        moves[i - 1] * 1.25,
      );
    }
  });
});

describe('every mode is still a game on move four', () => {
  // The gate balance.test.ts sets for the default board, applied to the two board
  // sizes the tide constants were never tuned on. A mode nobody can come back in
  // is not shippable however good the chip copy is.
  for (const m of MODE_LIST) {
    for (const players of [2, 4]) {
      it(`${m.id} at ${players}P does not snowball or favour the first seat`, () => {
        // 200 games, not the default 60: a win rate is a coin-flip statistic, and
        // at n=60 its 2-sigma noise is +/-13pp — wider than the band being
        // asserted, so a fair mode fails this a third of the time. (It did.)
        const s = shapeOf(m, players, 200);
        expect(s.blowouts, `${m.id} ${players}P blowouts`).toBeLessThan(0.13);
        if (players === 2) {
          // Measured 45 / 46 / 53%. The tide's coprime step (TIDE_EVERY) is what
          // cancels the first-player tempo edge, and it is a function of player
          // count — so it has to keep working on a board it never saw.
          expect(s.firstSeatWins, `${m.id} first seat`).toBeGreaterThan(0.38);
          expect(s.firstSeatWins, `${m.id} first seat`).toBeLessThan(0.62);
        }
      });
    }
  }
});

describe('the big board is affordable', () => {
  it('keeps a Ruthless AI move well inside a turn on the largest mode', () => {
    // Wilds is 143 tiles and 7 colours, and `hard` evaluates every legal colour,
    // then every one of the opponent's replies to each — so its cost grows with
    // colours SQUARED times board area. That is the one thing a bigger mode could
    // plausibly have made unaffordable, so it gets measured rather than assumed.
    // The solo driver fires the AI on a 520ms timer; anything near that is a hang.
    const m = MODES.wilds;
    const rand = makeRand(1);
    let s = generateBoard(3, { w: m.w, h: m.h, colors: m.colors, players: 4 });
    chooseAiColor(s, 0, 'hard', rand); // warm
    // Mid-game, where the blobs are big and the flood has the most to do.
    for (let i = 0; i < 20 && !s.finished; i++) {
      s = applyMove(s, s.turn, chooseAiColor(s, s.turn, 'normal', rand)).state;
    }
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) chooseAiColor(s, s.turn, 'hard', rand);
    const per = (performance.now() - t0) / 20;
    expect(per, `wilds hard AI move took ${per.toFixed(2)}ms`).toBeLessThan(50);
  });
});
