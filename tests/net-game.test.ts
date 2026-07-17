/**
 * net-game.test.ts — who is allowed to run a live match.
 *
 * The room now outlives the round (rematches happen inside it), so anyone may
 * walk in mid-game. net.host() is a min-id election over EVERYONE present, which
 * means a joiner with a small peer id wins it — and the shipped build handed that
 * joiner authority over a match it held no state for, freezing the board for good.
 *
 * The rule these tests pin: authority follows the round's FROZEN ROSTER. A peer
 * outside it is a spectator forever; inside it, the lowest connected seat hosts,
 * so a real player leaving still promotes the next one.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { NetGame } from '../src/net-game';
import { legalColors, type GameState } from '../src/game';
import type { Net, PeerId } from '../src/engine/net';

/** Shared in-memory bus, synchronous delivery — protocol, not timing. */
class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();

  join(id: PeerId): void {
    this.peers.set(id, new Map());
  }
  part(id: PeerId): void {
    this.peers.delete(id);
  }
  roster(): PeerId[] {
    return [...this.peers.keys()].sort();
  }
  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) for (const h of [...(this.peers.get(t)?.get(name) ?? [])]) h(data, from);
  }
  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void): () => void {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    // Identical rule to the real net.ts: lexicographically smallest id in the ROOM.
    host: () => bus.roster()[0],
    isHost: () => bus.roster()[0] === selfId,
    count: () => bus.roster().length,
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    leave: async () => bus.part(selfId),
  };
}

interface Peer {
  id: PeerId;
  net: Net;
  game: NetGame;
  state: () => GameState;
}

const SEED = 0xbeef;

/** Seat every id in `seats` into one round of the same match. */
function match(bus: Bus, seats: PeerId[]): Peer[] {
  return seats.map((id) => {
    const net = mockNet(bus, id);
    let last: GameState | null = null;
    const game = new NetGame({ net, seed: SEED, seats, onUpdate: (s) => (last = s) });
    return { id, net, game, state: () => last ?? game.getState() };
  });
}

/** A colour this seat may legally pick right now. */
function pick(s: GameState, seat: number): number {
  return legalColors(s, seat)[0];
}

let bus: Bus;
beforeEach(() => {
  bus = new Bus();
});

describe('NetGame — round authority', () => {
  it('seats the lowest roster id as host, matching net.host() when nobody else is around', () => {
    const [m, z] = match(bus, ['m', 'z']);
    expect(m.game.isHost()).toBe(true);
    expect(z.game.isHost()).toBe(false);
  });

  it('does NOT hand a mid-game joiner authority, and the match keeps running', () => {
    const [m, z] = match(bus, ['m', 'z']);
    m.game.play(pick(m.state(), 0)); // seat 0 opens
    expect(z.state().turnNo).toBe(1);

    // 'a' sorts before 'm', so it wins net.host() the instant it arrives. It holds
    // no board and is not in the roster: the old build froze here forever.
    const spectator = mockNet(bus, 'a');
    expect(spectator.host()).toBe('a');
    expect(m.net.isHost()).toBe(false);
    m.game.onRoster();
    z.game.onRoster();

    expect(m.game.isHost()).toBe(true); // authority stayed with the roster
    z.game.play(pick(z.state(), 1)); // and a client's move still lands
    expect(m.state().turnNo).toBe(2);
    expect(z.state().turnNo).toBe(2);
  });

  it('ignores a snapshot from a peer that is not the round host', () => {
    const [m, z] = match(bus, ['m', 'z']);
    m.game.play(pick(m.state(), 0));
    const real = z.state();

    mockNet(bus, 'a').channel('snap', () => {})({
      state: { ...real, turnNo: 999, finished: true },
      absorbed: [],
      mover: -1,
    } as never);

    expect(z.state().turnNo).toBe(1);
    expect(z.state().finished).toBe(false);
  });

  it('still promotes the next seat when the round host leaves (existing guarantee)', () => {
    const [m, z] = match(bus, ['m', 'z']);
    m.game.play(pick(m.state(), 0));

    void m.net.leave(); // the host closes the tab mid-match
    z.game.onRoster();

    expect(z.game.isHost()).toBe(true);
    z.game.play(pick(z.state(), 1)); // the promoted host applies its own move
    expect(z.state().turnNo).toBe(2);
  });
});

describe('NetGame — teardown', () => {
  it('detaches its channels so a finished round cannot answer the next one', () => {
    const [m, z] = match(bus, ['m', 'z']);
    m.game.play(pick(m.state(), 0));
    const before = m.state().turnNo;
    const next = pick(z.state(), 1);

    // The Net outlives the round and channel() fans out, so a leaked receiver
    // would let this dead round resolve the NEXT round's inputs against its stale
    // board and broadcast snapshots of it over the live match.
    m.game.destroy();
    z.game.destroy();

    z.net.channel('mv', () => {})({ color: next } as never, 'm');
    expect(m.state().turnNo).toBe(before);
  });
});
