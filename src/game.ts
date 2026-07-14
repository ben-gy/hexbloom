/**
 * game.ts — Hexbloom core rules. Pure, deterministic, and fully testable.
 *
 * A hex grid (odd-r offset, pointy-top) is painted in `colors` colours. Each
 * player owns one corner cell. On a turn a player picks a colour (any but their
 * current one): their whole territory recolours to it and then absorbs, by a
 * flood fill, every neutral tile of that colour touching the territory. When no
 * neutral tiles remain (or a full round passes with zero captures), the game
 * ends and the largest territory wins.
 *
 * Everything derives from a single numeric seed (via engine/rng), so two peers
 * that start from the same lobby seed build byte-identical boards — the P2P-sync
 * invariant. Nothing here calls Math.random().
 */

import { makeRng, randInt, shuffle } from './engine/rng';

export const DEFAULT_W = 9;
export const DEFAULT_H = 9;
export const DEFAULT_COLORS = 6;
export const NEUTRAL = -1;

export interface GameState {
  w: number;
  h: number;
  colors: number;
  players: number;
  /** Colour of every cell, indexed row-major (row * w + col). */
  tile: number[];
  /** Owner of every cell: NEUTRAL (-1) or a player index. */
  owner: number[];
  /** Each player's current colour. */
  color: number[];
  /** Whose turn it is (player index). */
  turn: number;
  /** Number of moves played so far. */
  turnNo: number;
  /** Consecutive moves that captured nothing — used to detect a stalled board. */
  stale: number;
  finished: boolean;
}

export interface MoveResult {
  state: GameState;
  /** Cell indices newly claimed by this move (for particle/juice feedback). */
  absorbed: number[];
}

export interface BoardOptions {
  w?: number;
  h?: number;
  colors?: number;
  players?: number;
}

/** odd-r offset neighbour deltas [dcol, drow] for even and odd rows. */
const ODDR_DELTAS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // even rows
  [
    [+1, 0],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, +1],
    [0, +1],
  ],
  // odd rows
  [
    [+1, 0],
    [+1, -1],
    [0, -1],
    [-1, 0],
    [0, +1],
    [+1, +1],
  ],
];

/** Neighbour cell indices of `i` on a w×h odd-r hex grid (2–6 of them). */
export function neighbors(i: number, w: number, h: number): number[] {
  const col = i % w;
  const row = Math.floor(i / w);
  const deltas = ODDR_DELTAS[row & 1];
  const out: number[] = [];
  for (const [dc, dr] of deltas) {
    const nc = col + dc;
    const nr = row + dr;
    if (nc >= 0 && nc < w && nr >= 0 && nr < h) out.push(nr * w + nc);
  }
  return out;
}

/** The corner start cells for a given player count, in turn order. */
export function startCells(w: number, h: number, players: number): number[] {
  const TL = 0;
  const TR = w - 1;
  const BL = (h - 1) * w;
  const BR = (h - 1) * w + (w - 1);
  if (players <= 2) return [TL, BR];
  if (players === 3) return [TL, BR, TR];
  return [TL, BR, TR, BL];
}

/** Deep copy of a state (arrays included) — keeps applyMove pure. */
export function cloneState(s: GameState): GameState {
  return {
    w: s.w,
    h: s.h,
    colors: s.colors,
    players: s.players,
    tile: s.tile.slice(),
    owner: s.owner.slice(),
    color: s.color.slice(),
    turn: s.turn,
    turnNo: s.turnNo,
    stale: s.stale,
    finished: s.finished,
  };
}

/** Flood-absorb neutral tiles of `player`'s current colour touching their blob. */
function floodAbsorb(s: GameState, player: number): number[] {
  const want = s.color[player];
  const absorbed: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === player) queue.push(i);
  while (queue.length) {
    const cell = queue.pop()!;
    for (const n of neighbors(cell, s.w, s.h)) {
      if (s.owner[n] === NEUTRAL && s.tile[n] === want) {
        s.owner[n] = player;
        absorbed.push(n);
        queue.push(n);
      }
    }
  }
  return absorbed;
}

/** Build a fresh, deterministic board from a seed. */
export function generateBoard(seed: number | string, opts: BoardOptions = {}): GameState {
  const w = opts.w ?? DEFAULT_W;
  const h = opts.h ?? DEFAULT_H;
  const colors = opts.colors ?? DEFAULT_COLORS;
  const players = Math.max(2, Math.min(4, opts.players ?? 2));
  const rng = makeRng(seed);

  const tile: number[] = new Array(w * h);
  for (let i = 0; i < tile.length; i++) tile[i] = randInt(rng, 0, colors - 1);

  const owner: number[] = new Array(w * h).fill(NEUTRAL);
  const starts = startCells(w, h, players);
  // Distinct starting colours so no two blobs fight over the same colour at gen.
  const palette = shuffle(rng, Array.from({ length: colors }, (_, i) => i));
  const color: number[] = [];
  for (let p = 0; p < players; p++) {
    const c = palette[p];
    color[p] = c;
    tile[starts[p]] = c;
    owner[starts[p]] = p;
  }

  // Balance the opening: isolate each seed cell so no player gets a free
  // starting blob from a lucky same-colour cluster on the random board. We
  // recolour any neutral neighbour that matches the seed's colour, so every
  // player begins with exactly one tile — fairness that doesn't depend on the
  // random layout. (Deterministic via rng, so peers still agree.)
  for (let p = 0; p < players; p++) {
    for (const n of neighbors(starts[p], w, h)) {
      if (owner[n] === NEUTRAL && tile[n] === color[p]) {
        let r = randInt(rng, 0, colors - 2);
        if (r >= color[p]) r++; // pick uniformly among colours != color[p]
        tile[n] = r;
      }
    }
  }

  const state: GameState = {
    w,
    h,
    colors,
    players,
    tile,
    owner,
    color,
    turn: 0,
    turnNo: 0,
    stale: 0,
    finished: false,
  };

  // Establish the "no un-absorbed same-colour neutral touching a blob"
  // invariant. After isolation this absorbs nothing, so all players start at 1.
  for (let p = 0; p < players; p++) floodAbsorb(state, p);
  return state;
}

/** Colours `player` may legally choose this turn (everything but their current). */
export function legalColors(s: GameState, player: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < s.colors; c++) if (c !== s.color[player]) out.push(c);
  return out;
}

export function neutralCount(s: GameState): number {
  let n = 0;
  for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === NEUTRAL) n++;
  return n;
}

/** Territory size per player. */
export function scores(s: GameState): number[] {
  const out = new Array(s.players).fill(0);
  for (let i = 0; i < s.owner.length; i++) {
    const o = s.owner[i];
    if (o !== NEUTRAL) out[o]++;
  }
  return out;
}

/** Player indices tied for the largest territory. */
export function winners(s: GameState): number[] {
  const sc = scores(s);
  const best = Math.max(...sc);
  const out: number[] = [];
  for (let p = 0; p < sc.length; p++) if (sc[p] === best) out.push(p);
  return out;
}

/**
 * Apply `player`'s choice of `color`. Returns a NEW state plus the list of cells
 * absorbed (for juice). Assumes it is `player`'s turn; an illegal colour (their
 * current one) is a no-op that still advances the turn defensively is avoided —
 * instead it returns the state unchanged so callers can guard.
 */
export function applyMove(prev: GameState, player: number, color: number): MoveResult {
  if (prev.finished || player !== prev.turn || color === prev.color[player]) {
    return { state: prev, absorbed: [] };
  }
  const s = cloneState(prev);
  s.color[player] = color;
  for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === player) s.tile[i] = color;
  const absorbed = floodAbsorb(s, player);

  s.turn = (s.turn + 1) % s.players;
  s.turnNo += 1;
  s.stale = absorbed.length === 0 ? s.stale + 1 : 0;
  if (neutralCount(s) === 0 || s.stale >= s.players) s.finished = true;
  return { state: s, absorbed };
}

/** How many tiles `player` would capture by choosing `color` right now. */
export function captureCount(s: GameState, player: number, color: number): number {
  return applyMove(s, player, color).absorbed.length;
}

/** Unique neutral tiles adjacent to `player`'s blob — their growth potential. */
export function frontierNeutral(s: GameState, player: number): number {
  const seen = new Set<number>();
  for (let i = 0; i < s.owner.length; i++) {
    if (s.owner[i] !== player) continue;
    for (const n of neighbors(i, s.w, s.h)) {
      if (s.owner[n] === NEUTRAL) seen.add(n);
    }
  }
  return seen.size;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * Pick a colour for an AI player. `normal`/`hard` are deterministic (ties break
 * to the lowest colour index) so they're testable; `easy` uses the supplied rng
 * (or Math.random) for a looser, more beatable opponent. AI never runs in P2P.
 */
export function chooseAiColor(
  s: GameState,
  player: number,
  difficulty: Difficulty = 'normal',
  rand: () => number = Math.random,
): number {
  const legal = legalColors(s, player);
  if (legal.length === 0) return s.color[player];

  if (difficulty === 'easy') {
    // Half the time greedy, half the time a random legal colour.
    if (rand() < 0.5) return legal[Math.floor(rand() * legal.length)];
  }

  let best = legal[0];
  let bestVal = -Infinity;
  for (const c of legal) {
    const res = applyMove(s, player, c);
    let val = res.absorbed.length;
    if (difficulty === 'hard') {
      const next = res.state;
      // Reward opening more frontier, penalise handing the opponent a big reply.
      const growth = frontierNeutral(next, player);
      let bestReply = 0;
      const opp = next.turn;
      if (!next.finished && opp !== player) {
        for (const oc of legalColors(next, opp)) {
          bestReply = Math.max(bestReply, captureCount(next, opp, oc));
        }
      }
      val = res.absorbed.length + 0.35 * growth - 0.25 * bestReply;
    }
    if (val > bestVal) {
      bestVal = val;
      best = c;
    }
  }
  return best;
}
