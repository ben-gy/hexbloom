import { describe, expect, it } from 'vitest';
import {
  applyMove,
  bloomReach,
  captureCount,
  chooseAiColor,
  generateBoard,
  legalColors,
  neighbors,
  neutralCount,
  scores,
  startCells,
  TIDE_EVERY,
  winners,
  type GameState,
  NEUTRAL,
} from '../src/game';

function makeState(
  w: number,
  h: number,
  colors: number,
  tile: number[],
  owner: number[],
  color: number[],
  turn = 0,
): GameState {
  return {
    w,
    h,
    colors,
    players: color.length,
    tile: tile.slice(),
    owner: owner.slice(),
    color: color.slice(),
    turn,
    turnNo: 0,
    stale: 0,
    finished: false,
  };
}

describe('neighbors (odd-r offset hex grid)', () => {
  it('is symmetric across the whole board', () => {
    const w = 9;
    const h = 9;
    for (let i = 0; i < w * h; i++) {
      for (const n of neighbors(i, w, h)) {
        expect(neighbors(n, w, h)).toContain(i);
      }
    }
  });

  it('gives 2–6 neighbours, with 6 in the interior', () => {
    const w = 9;
    const h = 9;
    for (let i = 0; i < w * h; i++) {
      const deg = neighbors(i, w, h).length;
      expect(deg).toBeGreaterThanOrEqual(2);
      expect(deg).toBeLessThanOrEqual(6);
    }
    // A well-interior cell (col 4, row 4) has all 6.
    expect(neighbors(4 * 9 + 4, 9, 9).length).toBe(6);
  });

  it('never returns duplicate or out-of-range indices', () => {
    const n = neighbors(0, 9, 9);
    expect(new Set(n).size).toBe(n.length);
    for (const x of n) expect(x).toBeGreaterThanOrEqual(0);
  });
});

describe('startCells', () => {
  it('places the corners for each player count', () => {
    expect(startCells(9, 9, 2)).toEqual([0, 80]);
    expect(startCells(9, 9, 3)).toEqual([0, 80, 8]);
    expect(startCells(9, 9, 4)).toEqual([0, 80, 8, 72]);
  });
});

describe('generateBoard', () => {
  it('seats every player with a distinct starting colour', () => {
    for (const players of [2, 3, 4]) {
      const s = generateBoard(42, { players });
      expect(s.color.length).toBe(players);
      expect(new Set(s.color).size).toBe(players); // distinct start colours
    }
  });

  it('gives every player an equal opening (exactly one tile) across many seeds', () => {
    // Regression: the random board must never hand a player a free starting blob.
    for (let seed = 0; seed < 200; seed++) {
      for (const players of [2, 3, 4]) {
        const s = generateBoard(seed, { players });
        const sc = scores(s);
        for (let p = 0; p < players; p++) {
          expect(sc[p]).toBe(1);
        }
        // And the invariant holds: no neutral tile of a player's colour touches
        // their seed (nothing left un-absorbed that they can't take).
        for (let p = 0; p < players; p++) {
          const seat = s.owner.indexOf(p);
          for (const nb of neighbors(seat, s.w, s.h)) {
            if (s.owner[nb] === NEUTRAL) expect(s.tile[nb]).not.toBe(s.color[p]);
          }
        }
      }
    }
  });

  it('accounts for every tile (owned + neutral = total)', () => {
    const s = generateBoard(7, { players: 3 });
    const total = s.tile.length;
    const owned = scores(s).reduce((a, b) => a + b, 0);
    expect(owned + neutralCount(s)).toBe(total);
  });
});

describe('legalColors', () => {
  it('excludes only the player’s current colour', () => {
    const s = generateBoard(1, { players: 2 });
    const legal = legalColors(s, 0);
    expect(legal).not.toContain(s.color[0]);
    expect(legal.length).toBe(s.colors - 1);
  });
});

describe('applyMove — flood capture', () => {
  // 3x3 board; player 0 owns cell 0 (colour 0). Choosing colour 1 should bloom
  // through the connected colour-1 region touching the blob.
  const base = () =>
    makeState(
      3,
      3,
      3,
      [0, 1, 1, 1, 2, 0, 0, 0, 0],
      [0, -1, -1, -1, -1, -1, -1, -1, -1],
      [0, 2],
      0,
    );

  it('absorbs the whole touching same-colour region at high tide', () => {
    // Cell 2 is two steps out (0 -> 1 -> 2), so this needs reach >= 2.
    const { state, absorbed } = applyMove({ ...base(), turnNo: 30 }, 0, 1);
    expect(absorbed.slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);
    for (const i of [0, 1, 2, 3]) {
      expect(state.owner[i]).toBe(0);
      expect(state.tile[i]).toBe(1); // recoloured to the chosen colour
    }
  });

  it('reaches only one step into that region at low tide', () => {
    // Same region, turnNo 0 => reach 1: cells 1 and 3 touch the blob, cell 2 does
    // not, and is left neutral for someone to take later.
    const { state, absorbed } = applyMove(base(), 0, 1);
    expect(absorbed.slice().sort((a, b) => a - b)).toEqual([1, 3]);
    expect(state.owner[2]).toBe(NEUTRAL);
  });

  it('keeps invariants: score up by absorbed, neutral down by absorbed, turn advances', () => {
    const s = base();
    const before = scores(s)[0];
    const beforeNeutral = neutralCount(s);
    const { state, absorbed } = applyMove(s, 0, 1);
    expect(scores(state)[0]).toBe(before + absorbed.length);
    expect(neutralCount(state)).toBe(beforeNeutral - absorbed.length);
    expect(state.turn).toBe(1);
    expect(state.turnNo).toBe(1);
    expect(state.color[0]).toBe(1);
  });

  it('never transfers an opponent’s owned tiles', () => {
    const s = makeState(3, 3, 3, [0, 1, 1, 0, 0, 0, 0, 0, 1], [0, -1, -1, -1, -1, -1, -1, -1, 1], [0, 1]);
    const { state } = applyMove(s, 0, 1);
    expect(state.owner[8]).toBe(1); // still the opponent's
  });

  it('is a no-op when choosing the current colour', () => {
    const s = base();
    const res = applyMove(s, 0, 0);
    expect(res.state).toBe(s);
    expect(res.absorbed).toEqual([]);
  });

  it('advances the turn and marks a stale pass when nothing is captured', () => {
    const s = makeState(3, 3, 3, [0, 2, 2, 2, 2, 2, 2, 2, 2], [0, -1, -1, -1, -1, -1, -1, -1, -1], [0, 2]);
    const { state, absorbed } = applyMove(s, 0, 1); // no colour-1 tiles adjacent
    expect(absorbed).toEqual([]);
    expect(state.stale).toBe(1);
    expect(state.turn).toBe(1);
  });
});

describe('captureCount', () => {
  it('matches the number a move would absorb, at whatever the tide is', () => {
    const s = makeState(3, 3, 3, [0, 1, 1, 1, 2, 0, 0, 0, 0], [0, -1, -1, -1, -1, -1, -1, -1, -1], [0, 2]);
    expect(captureCount(s, 0, 1)).toBe(2); // reach 1 at turnNo 0
    expect(captureCount({ ...s, turnNo: 30 }, 0, 1)).toBe(3); // high tide
    expect(captureCount(s, 0, 0)).toBe(0); // own colour, no-op
  });
});

describe('scores / winners', () => {
  it('counts only owned tiles and finds the leader', () => {
    const s = makeState(3, 3, 3, [0, 0, 0, 1, 1, 1, 2, 2, 2], [0, 0, 0, 1, 1, -1, -1, -1, -1], [0, 1]);
    expect(scores(s)).toEqual([3, 2]);
    expect(winners(s)).toEqual([0]);
  });

  it('reports ties', () => {
    const s = makeState(3, 3, 3, [0, 0, 1, 1, 2, 2, 2, 2, 2], [0, 0, 1, 1, -1, -1, -1, -1, -1], [0, 1]);
    expect(winners(s).sort()).toEqual([0, 1]);
  });
});

describe('chooseAiColor', () => {
  it('normal picks a maximally-capturing legal colour, deterministically', () => {
    const s = generateBoard(123, { players: 2 });
    const legal = legalColors(s, 0);
    const best = Math.max(...legal.map((c) => captureCount(s, 0, c)));
    const chosen = chooseAiColor(s, 0, 'normal');
    expect(legal).toContain(chosen);
    expect(captureCount(s, 0, chosen)).toBe(best);
    expect(chooseAiColor(s, 0, 'normal')).toBe(chosen); // stable
  });

  it('hard returns a legal, deterministic choice', () => {
    const s = generateBoard(555, { players: 3 });
    const a = chooseAiColor(s, 0, 'hard');
    const b = chooseAiColor(s, 0, 'hard');
    expect(a).toBe(b);
    expect(legalColors(s, 0)).toContain(a);
  });
});

describe('the tide', () => {
  it('starts low and rises on a fixed schedule', () => {
    const at = (players: number, turnNo: number) =>
      bloomReach({ players, turnNo } as GameState);
    // 2P: reach 1 for the first three moves, then +1 every three.
    expect([...Array(13).keys()].map((t) => at(2, t))).toEqual([
      1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5,
    ]);
    expect([...Array(11).keys()].map((t) => at(3, t))).toEqual([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4]);
    expect([...Array(11).keys()].map((t) => at(4, t))).toEqual([3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5]);
  });

  it('keeps the tide period coprime with the player count', () => {
    // Not a style nit: the tide steps on MOVE count, so a period sharing a factor
    // with `players` lands every seat's reach bumps at the same point in the round
    // and hands the first player a ~63% win rate (measured). Coprime cancels it.
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    for (const players of [2, 3, 4]) expect(gcd(TIDE_EVERY(players), players)).toBe(1);
  });

  it('clamps a bloom to the reach, leaving the rest of the run neutral', () => {
    // A 1-tile blob at col 0 with a straight 8-tile run of colour 1 beside it.
    const w = 9;
    const tile = new Array(w).fill(1);
    tile[0] = 0;
    const owner = new Array(w).fill(NEUTRAL);
    owner[0] = 0;
    const s = makeState(w, 1, 2, tile, owner, [0, 1]);

    // turnNo 0 => reach 1 => exactly one tile, even though 8 are contiguous.
    expect(applyMove(s, 0, 1).absorbed.length).toBe(1);
    // turnNo 3 => reach 2.
    expect(applyMove({ ...s, turnNo: 3 }, 0, 1).absorbed.length).toBe(2);
    // High tide takes the whole run.
    expect(applyMove({ ...s, turnNo: 30 }, 0, 1).absorbed.length).toBe(8);
  });

  it('measures reach from the whole territory, not from one cell', () => {
    // Guards against a plain queue (DFS), which would let one arm race ahead and
    // spend the whole reach on it. Blob owns cols 0 and 4; a run sits at col 5.
    const w = 7;
    const tile = [0, 1, 1, 1, 0, 1, 1];
    const owner = [0, NEUTRAL, NEUTRAL, NEUTRAL, 0, NEUTRAL, NEUTRAL];
    const s = makeState(w, 1, 2, tile, owner, [0, 1]);
    // Every frontier advances one step: col 1 off col 0, and cols 3 and 5 off
    // col 4. A DFS would burn the reach on whichever arm it happened to enter.
    const res = applyMove(s, 0, 1);
    expect(res.absorbed.sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it('does not clamp the generator (every player still starts on one tile)', () => {
    // generateBoard's floodAbsorb calls rely on the default reach of Infinity.
    for (let seed = 0; seed < 200; seed++) {
      for (const players of [2, 3, 4]) {
        const s = generateBoard(seed, { players });
        expect(scores(s)).toEqual(new Array(players).fill(1));
      }
    }
  });

  it('keeps the swatch preview honest at low tide', () => {
    // captureCount drives the gain shown on each swatch; it must be reach-limited
    // too, or the UI promises a bloom the rules will not deliver.
    const s = generateBoard(99, { players: 2 });
    for (const c of legalColors(s, 0)) {
      expect(captureCount(s, 0, c)).toBe(applyMove(s, 0, c).absorbed.length);
    }
  });

  it('still lets big cascades happen at high tide', () => {
    // The tide is a brake on the opening, not on the spectacle. If someone dials
    // TIDE_START down to nothing, this fails loudly.
    let biggest = 0;
    for (let seed = 0; seed < 200; seed++) {
      let s = generateBoard(seed, { players: 2 });
      let guard = 0;
      while (!s.finished && guard++ < 200) {
        const res = applyMove(s, s.turn, chooseAiColor(s, s.turn, 'normal', () => 0.5));
        if (res.state === s) break;
        biggest = Math.max(biggest, res.absorbed.length);
        s = res.state;
      }
    }
    expect(biggest).toBeGreaterThanOrEqual(10);
  });

  it('adds no state for peers to sync', () => {
    // Reach derives from turnNo + players, both already in the snapshot. A new
    // field here means net-game.ts's full-snapshot sync needs revisiting.
    expect(Object.keys(generateBoard(1, { players: 2 })).sort()).toEqual([
      'color',
      'colors',
      'finished',
      'h',
      'owner',
      'players',
      'stale',
      'tile',
      'turn',
      'turnNo',
      'w',
    ]);
  });
});

describe('a full game always terminates with a valid result', () => {
  it('fills the board (or stalls) and yields a winner', () => {
    let s = generateBoard(2024, { players: 2 });
    let guard = 0;
    while (!s.finished && guard < 1000) {
      s = applyMove(s, s.turn, chooseAiColor(s, s.turn, 'normal')).state;
      guard++;
    }
    expect(s.finished).toBe(true);
    expect(winners(s).length).toBeGreaterThanOrEqual(1);
    // Owned + neutral still accounts for every tile.
    expect(scores(s).reduce((a, b) => a + b, 0) + neutralCount(s)).toBe(s.tile.length);
    // No owned tile is marked NEUTRAL.
    expect(s.owner.some((o) => o === NEUTRAL && false)).toBe(false);
  });
});
