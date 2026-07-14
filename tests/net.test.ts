/**
 * Netcode snapshot invariants. The host broadcasts the full GameState as a
 * snapshot; clients adopt it verbatim. A snapshot must survive JSON round-tripping
 * unchanged, and a state carried "over the wire" must advance identically on every
 * peer (no desync). Seating is derived by sorting peer ids, so it agrees on all
 * peers regardless of local roster order.
 */
import { describe, expect, it } from 'vitest';
import { applyMove, chooseAiColor, generateBoard, type GameState } from '../src/game';

function roundTrip(s: GameState): GameState {
  return JSON.parse(JSON.stringify(s)) as GameState;
}

describe('snapshot serialization', () => {
  it('round-trips a board unchanged', () => {
    const s = generateBoard(0xbee, { players: 4 });
    expect(roundTrip(s)).toEqual(s);
  });

  it('round-trips mid-game state including turn/stale/finished', () => {
    let s = generateBoard(99, { players: 3 });
    for (let i = 0; i < 10; i++) s = applyMove(s, s.turn, chooseAiColor(s, s.turn, 'normal')).state;
    const wire = roundTrip(s);
    expect(wire).toEqual(s);
    expect(wire.turn).toBe(s.turn);
    expect(wire.finished).toBe(s.finished);
  });
});

describe('cross-peer determinism (no desync)', () => {
  it('the same move on a snapshot yields the same next state', () => {
    const host = generateBoard('ROOM42', { players: 2 });
    const client = roundTrip(host); // client received the snapshot

    // Both apply the same move (host authoritatively, client predicting).
    const color = chooseAiColor(host, 0, 'normal');
    const hostNext = applyMove(host, 0, color).state;
    const clientNext = applyMove(client, 0, color).state;
    expect(clientNext).toEqual(hostNext);
  });

  it('a full move sequence stays in lockstep', () => {
    let a = generateBoard(2025, { players: 4 });
    let b = roundTrip(a);
    for (let i = 0; i < 40 && !a.finished; i++) {
      const color = chooseAiColor(a, a.turn, 'normal');
      a = applyMove(a, a.turn, color).state;
      b = applyMove(b, b.turn, color).state;
      expect(b).toEqual(a);
    }
  });
});

describe('seating derivation is order-independent', () => {
  it('sorting peer ids gives the same seats regardless of local order', () => {
    const ids = ['zeta', 'alpha', 'mike'];
    const seatsFromA = [...ids].sort((x, y) => x.localeCompare(y));
    const seatsFromB = [...ids].reverse().sort((x, y) => x.localeCompare(y));
    expect(seatsFromA).toEqual(seatsFromB);
    expect(seatsFromA).toEqual(['alpha', 'mike', 'zeta']);
  });
});
