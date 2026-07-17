/**
 * balance.test.ts — is this still a game on move 4?
 *
 * The other suites prove the rules WORK. None of them can tell you the winner is
 * already decided. Hexbloom shipped 34 green tests and a clean production check
 * while whoever led after 3 moves won 64% of the time and 31% of games were
 * blowouts — a snowball is invisible to unit tests and to a 90-second playtest.
 *
 * So: play a few hundred fixed-seed AI-vs-AI games and assert on the SHAPE of the
 * outcome. This is the referee for any balance change — the measured curve, not a
 * plausible story about the mechanics. On this game nearly every plausible story
 * turned out to be wrong (see game.ts's TIDE_START comment and the factory
 * routine's principle #18).
 *
 * Deterministic and seeded: no Math.random, same numbers on every run and machine.
 */

import { describe, expect, it } from 'vitest';
import { applyMove, chooseAiColor, generateBoard, scores, winners, type Difficulty } from '../src/game';

/** Seeded rng so the AI's `easy` branch and the sim itself never vary run to run. */
function makeRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Outcome {
  /** Sole leader at each sampled move, or -1 if tied. */
  leadAt: Record<number, number>;
  /** Sole winner, or -1 on a draw. */
  winner: number;
  turns: number;
  /** Winner's lead over 2nd place, as a share of the claimed board. */
  margin: number;
}

function playOut(seed: number, diffs: Difficulty[], sample: number[]): Outcome {
  const rand = makeRand(seed * 7919 + 13);
  let s = generateBoard(seed, { players: diffs.length });
  const leadAt: Record<number, number> = {};
  let guard = 0;
  while (!s.finished && guard++ < 300) {
    const p = s.turn;
    const res = applyMove(s, p, chooseAiColor(s, p, diffs[p], rand));
    if (res.state === s) break; // no legal progress — shouldn't happen
    s = res.state;
    if (sample.includes(s.turnNo)) {
      const sc = scores(s);
      const best = Math.max(...sc);
      leadAt[s.turnNo] = sc.filter((x) => x === best).length > 1 ? -1 : sc.indexOf(best);
    }
  }
  const w = winners(s);
  const sorted = [...scores(s)].sort((a, b) => b - a);
  const claimed = sorted.reduce((a, b) => a + b, 0) || 1;
  return {
    leadAt,
    winner: w.length === 1 ? w[0] : -1,
    turns: s.turnNo,
    margin: (sorted[0] - sorted[1]) / claimed,
  };
}

const SAMPLE = [2, 3, 4, 8, 14];

function run(diffs: Difficulty[], games: number) {
  const out: Outcome[] = [];
  for (let i = 0; i < games; i++) out.push(playOut(i * 1013 + 7, diffs, SAMPLE));
  return out;
}

/** How often the sole leader at move `n` went on to win. Ties excluded. */
function leaderHoldsAt(rs: Outcome[], n: number): number {
  const decided = rs.filter((r) => r.leadAt[n] !== undefined && r.leadAt[n] !== -1 && r.winner >= 0);
  if (!decided.length) return NaN;
  return decided.filter((r) => r.leadAt[n] === r.winner).length / decided.length;
}

function seatWinRates(rs: Outcome[], players: number): number[] {
  const wins = new Array(players).fill(0);
  for (const r of rs) if (r.winner >= 0) wins[r.winner]++;
  return wins.map((w) => w / rs.length);
}

describe('balance — the game must not be over before it starts', () => {
  const results = run(['normal', 'normal'], 220);

  it('leaves the opening genuinely undecided', () => {
    // The complaint that started this: "decided in the first two or three moves."
    // Pre-tide this was 0.64 at move 3 and climbing. Now ~0.54 — near a coin flip.
    // If this regresses, an early lead is once again a won game.
    expect(leaderHoldsAt(results, 3)).toBeLessThan(0.6);
    expect(leaderHoldsAt(results, 4)).toBeLessThan(0.62);
  });

  it('keeps the midgame live', () => {
    // Pre-tide: 0.83 by move 8 — over with two thirds of the board still neutral.
    expect(leaderHoldsAt(results, 8)).toBeLessThan(0.72);
  });

  it('still resolves decisively by the end', () => {
    // The other failure mode: a "fix" that flattens every game into a coin flip is
    // just as bad. Late leads MUST mostly hold, or nothing a player does matters.
    expect(leaderHoldsAt(results, 14)).toBeGreaterThan(0.7);
  });

  it('rarely ends in a blowout', () => {
    const blowouts = results.filter((r) => r.margin > 0.25).length / results.length;
    expect(blowouts).toBeLessThan(0.2); // was 0.31
  });

  it('always terminates in a sane number of moves', () => {
    for (const r of results) {
      expect(r.turns).toBeGreaterThan(8);
      expect(r.turns).toBeLessThan(60);
    }
  });
});

describe('balance — seat fairness', () => {
  // Sample sizes here are deliberate, not arbitrary. At 220 games the pre-tide
  // seat split measures 51/49 and looks perfectly fair — the bug only separates
  // from the noise around 600. A seat test too small to see the bug it guards is
  // worse than none: it reports a fairness you never verified. Verified by hand:
  // tide on => 50.3/49.7 and 48.0/52.0; tide off => 55.8/44.2 and 57.0/43.0. The
  // bounds sit between those, so this test fails if the tide is weakened.
  it('gives neither 2P seat a meaningful edge', () => {
    // Moving first was worth ~56% before the tide. The ramp steps on MOVE count
    // with a period coprime to the player count, which cancels it — see TIDE_EVERY.
    const rates = seatWinRates(run(['normal', 'normal'], 600), 2);
    for (const r of rates) expect(r).toBeGreaterThan(0.455);
    for (const r of rates) expect(r).toBeLessThan(0.545);
  });

  it('gives neither 2P seat an edge against a stronger AI either', () => {
    const rates = seatWinRates(run(['hard', 'hard'], 300), 2);
    for (const r of rates) expect(r).toBeGreaterThan(0.44);
    for (const r of rates) expect(r).toBeLessThan(0.56);
  });

  // KNOWN BUG, PRE-DATES THE TIDE, NOT YET FIXED. Measured over 900 games:
  //   3P seats: 52 / 38 /  6   (fair = 33 each)
  //   4P seats: 31 / 35 / 16 / 11   (fair = 25 each)
  // The third player in a 3-player game wins roughly one game in twenty. The cause
  // is start geometry, not the tide: startCells puts 3P at [TL, BR, TR], whose
  // pairwise hex distances are 12/8/8, so TR is wedged between the other two and
  // suffocates. An equilateral [TL, TR, BotMid] measures WORSE (22/24/54) — the
  // mid-edge seat has more open neighbours — so equidistance alone is not the fix.
  // It likely needs inset seeds at equal edge-distance, and re-measuring here.
  it.todo('gives every 3P and 4P seat an even chance — currently 52/38/6 and 31/35/16/11');
});

describe('balance — the fix must not cost the game its joy', () => {
  it('still lands big cascades', () => {
    // The tide is a brake on the OPENING, not on the spectacle. A capture cap was
    // the other candidate here: it fixed every number above and took the max bloom
    // to 5 tiles, with 0% of blooms >= 6 — it balanced the game by deleting the
    // reason to play it. Guard the verb, not just the curve.
    const sizes: number[] = [];
    for (let i = 0; i < 120; i++) {
      const rand = makeRand(i * 31 + 5);
      let s = generateBoard(i * 1013 + 7, { players: 2 });
      let guard = 0;
      while (!s.finished && guard++ < 300) {
        const res = applyMove(s, s.turn, chooseAiColor(s, s.turn, 'normal', rand));
        if (res.state === s) break;
        sizes.push(res.absorbed.length);
        s = res.state;
      }
    }
    sizes.sort((a, b) => a - b);
    const p90 = sizes[Math.floor(sizes.length * 0.9)];
    const big = sizes.filter((n) => n >= 6).length / sizes.length;
    expect(p90).toBeGreaterThanOrEqual(5); // baseline 7
    expect(big).toBeGreaterThan(0.12); // baseline 25%
    expect(sizes[sizes.length - 1]).toBeGreaterThanOrEqual(10); // a real climax still happens
  });

  it('keeps a skill gradient — hard beats greedy handily', () => {
    // A balanced game where choices don't matter is a slot machine. `hard`'s eval
    // weights are tuned against this: it should win ~70% of seat-balanced games.
    let hardWins = 0;
    let games = 0;
    for (let i = 0; i < 40; i++) {
      for (const hardSeat of [0, 1]) {
        const rand = makeRand(i * 31 + 5);
        let s = generateBoard(i * 1013 + 7, { players: 2 });
        let guard = 0;
        while (!s.finished && guard++ < 300) {
          const p = s.turn;
          const diff: Difficulty = p === hardSeat ? 'hard' : 'normal';
          const res = applyMove(s, p, chooseAiColor(s, p, diff, rand));
          if (res.state === s) break;
          s = res.state;
        }
        const w = winners(s);
        games++;
        if (w.length === 1 && w[0] === hardSeat) hardWins++;
      }
    }
    expect(hardWins / games).toBeGreaterThan(0.6);
  });
});
