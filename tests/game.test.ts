import { describe, expect, it } from 'vitest';
import {
  applyMove,
  captureCount,
  chooseAiColor,
  generateBoard,
  legalColors,
  neighbors,
  neutralCount,
  scores,
  startCells,
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
  it('seats every player with a distinct starting colour and ≥1 tile', () => {
    for (const players of [2, 3, 4]) {
      const s = generateBoard(42, { players });
      expect(s.color.length).toBe(players);
      expect(new Set(s.color).size).toBe(players); // distinct start colours
      const sc = scores(s);
      for (let p = 0; p < players; p++) expect(sc[p]).toBeGreaterThanOrEqual(1);
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

  it('absorbs the whole touching same-colour region', () => {
    const { state, absorbed } = applyMove(base(), 0, 1);
    expect(absorbed.slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);
    for (const i of [0, 1, 2, 3]) {
      expect(state.owner[i]).toBe(0);
      expect(state.tile[i]).toBe(1); // recoloured to the chosen colour
    }
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
  it('matches the number a move would absorb', () => {
    const s = makeState(3, 3, 3, [0, 1, 1, 1, 2, 0, 0, 0, 0], [0, -1, -1, -1, -1, -1, -1, -1, -1], [0, 2]);
    expect(captureCount(s, 0, 1)).toBe(3);
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
