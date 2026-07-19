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
import type { Net, PeerId } from '@ben-gy/game-engine/net';

/** Shared in-memory bus, synchronous delivery — protocol, not timing. */
class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  /** Per-peer roster listeners, backing net.onPeersChange(). */
  watchers = new Map<PeerId, Set<(peers: PeerId[]) => void>>();

  join(id: PeerId): void {
    this.peers.set(id, new Map());
    this.watchers.set(id, new Set());
    this.rosterChanged();
  }
  part(id: PeerId): void {
    this.peers.delete(id);
    this.watchers.delete(id);
    this.rosterChanged();
  }
  private rosterChanged(): void {
    const roster = this.roster();
    for (const set of [...this.watchers.values()]) for (const cb of [...set]) cb(roster);
  }
  watch(id: PeerId, cb: (peers: PeerId[]) => void): () => void {
    const set = this.watchers.get(id)!;
    set.add(cb);
    return () => set.delete(cb);
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

/**
 * `roomHost` stands in for net.ts's incumbent — the peer that has held the room
 * since it was minted. Default: the pessimistic min-id rule, so the mid-game
 * joiner below really does win the room and authority has to refuse it anyway.
 */
function mockNet(bus: Bus, selfId: PeerId, roomHost: () => PeerId | null = () => bus.roster()[0]): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    host: roomHost,
    isHost: () => roomHost() === selfId,
    hostSettled: () => true,
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
    // ── engine v1.1.0 additions ──────────────────────────────────────────────
    // These tests are about NetGame refusing authority to the wrong peer, so the
    // interesting part is `roomHost` above; the epoch is what the REAL net uses
    // to make that same call, and a constant is honest for a bus with no race.
    hostEpoch: () => 1,
    onPeersChange: (cb) => bus.watch(selfId, cb),
    takeover: () => {
      /* the room's incumbent is fixed by `roomHost` — nothing to seize */
    },
    netDiag: () => ({
      selfId,
      host: roomHost(),
      epoch: 1,
      settled: true,
      peers: bus.roster(),
      relaySockets: {},
      turn: false,
    }),
  };
}

interface Peer {
  id: PeerId;
  net: Net;
  game: NetGame;
  state: () => GameState;
}

const SEED = 0xbeef;
/** Every peer in a round is handed the host's board, byte-identical. */
const BOARD = { w: 9, h: 9, colors: 6 };

/** Seat every id in `seats` into one round of the same match. */
function match(bus: Bus, seats: PeerId[], roomHost?: () => PeerId | null): Peer[] {
  return seats.map((id) => {
    const net = mockNet(bus, id, roomHost);
    let last: GameState | null = null;
    const game = new NetGame({
      net,
      seed: SEED,
      seats,
      board: BOARD,
      onUpdate: (s) => (last = s),
    });
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

  it('gives the round to the ROOM\'s incumbent host, not to the lowest seat', () => {
    // 'z' minted the room and still holds it, so it hosts the round even though
    // 'm' sorts lower. There is one answer to "who is host", and this is it —
    // two notions (net.host() vs lowest seat) would have the players' moves and
    // the snapshots flowing to different peers.
    const [m, z] = match(bus, ['m', 'z'], () => 'z');
    expect(z.game.isHost()).toBe(true);
    expect(m.game.isHost()).toBe(false);

    m.game.play(pick(m.state(), 0)); // seat 0 asks the incumbent to apply it
    expect(z.state().turnNo).toBe(1);
    expect(m.state().turnNo).toBe(1);
  });

  it('hands the round on when the incumbent host leaves mid-match', () => {
    // net.ts promotes a survivor when the host leaves; the round must follow it
    // rather than sit waiting for a peer that is gone.
    let incumbent: PeerId | null = 'z';
    const [m, z] = match(bus, ['m', 'z'], () => incumbent);
    expect(z.game.isHost()).toBe(true);
    expect(m.game.isHost()).toBe(false);

    void z.net.leave();
    incumbent = 'm'; // min-id among the survivors, as net.ts elects
    m.game.onRoster();

    expect(m.game.isHost()).toBe(true);
    m.game.play(pick(m.state(), 0));
    expect(m.state().turnNo).toBe(1);
  });

  it('falls back to the lowest live seat while the room has no settled host', () => {
    // host() is null for the first moments in a room. Every peer must still reach
    // the same answer alone, or the opening position comes from two sources.
    const [m, z] = match(bus, ['m', 'z'], () => null);
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

describe("NetGame — the host's board, frozen", () => {
  it('builds the board the round start carried, not the default one', () => {
    // The mode reaches NetGame as bytes from the host. If it were dropped here,
    // a guest would silently build the 9x9 default while the host played a 13x11
    // Wilds, and the first snapshot would replace the grid under their finger.
    const bus2 = new Bus();
    const net = mockNet(bus2, 'a');
    const game = new NetGame({
      net,
      seed: SEED,
      seats: ['a', 'b'],
      board: { w: 13, h: 11, colors: 7 },
      onUpdate: () => {},
    });
    const s = game.getState();
    expect([s.w, s.h, s.colors]).toEqual([13, 11, 7]);
    expect(s.tile).toHaveLength(143);
    game.destroy();
  });

  it('gives two peers on the same seed and board an identical honeycomb', () => {
    // The whole point of freezing it: same seed + same board = same bytes, with
    // no negotiation. Same seed and a DIFFERENT board is just two games.
    const [a, b] = match(new Bus(), ['a', 'b']);
    expect(a.game.getState().tile).toEqual(b.game.getState().tile);
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
