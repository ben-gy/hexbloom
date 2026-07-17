/**
 * host-election.test.ts — who hosts a room, and when that is allowed to change.
 *
 * The rule, in one line: THE HOST ONLY CHANGES WHEN THE HOST LEAVES.
 *
 * Two shipped bugs live here, and both are asserted directly:
 *
 *  1. Host stolen on join. Election used to be "smallest peer id among live
 *     peers", recomputed on every join — so a peer arriving with a lower id took
 *     the room, holding none of its state. A coin flip on every single join,
 *     which is why one clean two-tab run proved nothing.
 *
 *  2. Everyone hosting a room that never formed. Each peer seeded ITSELF as host
 *     on join, so until discovery completed every peer painted itself host. On a
 *     slow or failed mesh that is permanent: both players sit in the right room
 *     code, each convinced they are the host, seeing nobody.
 *
 * Trystero is stubbed: this is our election logic, and it must be provable
 * without a relay, a browser, or luck about which random id sorts lower.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Net } from '../src/engine/net';

interface Wire {
  peers: Map<string, Room>;
}
const wire: Wire = { peers: new Map() };

/** A Trystero stand-in with a hand-driven mesh. */
class Room {
  id: string;
  roomId: string;
  receivers = new Map<string, (d: unknown, from: string) => void>();
  joinCbs: ((id: string) => void)[] = [];
  leaveCbs: ((id: string) => void)[] = [];
  connected = new Set<string>();
  left = false;

  constructor(id: string, roomId: string) {
    this.id = id;
    this.roomId = roomId;
  }

  getPeers(): Record<string, unknown> {
    return Object.fromEntries([...this.connected].map((p) => [p, {}]));
  }

  makeAction(name: string): [(d: unknown, to?: string | string[]) => void, (cb: never) => void] {
    return [
      (data: unknown, to?: string | string[]) => {
        const targets = to
          ? Array.isArray(to)
            ? to
            : [to]
          : [...this.connected];
        for (const t of targets) {
          const peer = wire.peers.get(t);
          if (peer && !peer.left && peer.roomId === this.roomId) {
            peer.receivers.get(name)?.(data, this.id);
          }
        }
      },
      ((cb: (d: unknown, from: string) => void) => this.receivers.set(name, cb)) as never,
    ];
  }

  onPeerJoin(cb: (id: string) => void): void {
    this.joinCbs.push(cb);
  }
  onPeerLeave(cb: (id: string) => void): void {
    this.leaveCbs.push(cb);
  }
  async leave(): Promise<void> {
    this.left = true;
    for (const other of wire.peers.values()) {
      if (other !== this && other.connected.delete(this.id)) {
        other.leaveCbs.forEach((cb) => cb(this.id));
      }
    }
    wire.peers.delete(this.id);
  }
}

/** Introduce two peers to each other, as the relay eventually would. */
function connect(a: string, b: string): void {
  const ra = wire.peers.get(a)!;
  const rb = wire.peers.get(b)!;
  ra.connected.add(b);
  rb.connected.add(a);
  ra.joinCbs.forEach((cb) => cb(b));
  rb.joinCbs.forEach((cb) => cb(a));
}

/**
 * Build a Net whose selfId we choose, so id ORDER is explicit rather than a coin
 * flip on which random id happens to sort lower.
 *
 * Each peer must be a separate MODULE INSTANCE, not just a separate Net: both
 * Trystero's `selfId` and net.ts's join registry are one-per-page globals, so a
 * shared import would give every simulated peer the same identity. Resetting the
 * module registry per peer is what a fresh browser actually is.
 */
async function peer(id: string, opts: { claimHost?: boolean } = {}): Promise<Net> {
  vi.resetModules();
  vi.doMock('trystero', () => ({
    selfId: id,
    joinRoom: (_c: { appId: string }, roomId: string) => {
      const room = new Room(id, roomId);
      wire.peers.set(id, room);
      return room;
    },
  }));
  const mod = await import('../src/engine/net');
  return mod.createNet({ appId: 'hexbloom-election', roomId: 'R', claimHost: opts.claimHost });
}

beforeEach(() => {
  // Peers from an earlier case keep their own module instance alive, complete
  // with a pending settle timer. Clearing the clock as well as the wire stops a
  // dead peer's timer firing into the case that follows.
  wire.peers.clear();
  vi.useRealTimers();
  vi.useFakeTimers();
});

describe('host election — the incumbent keeps the room', () => {
  it('does NOT hand the room to a joiner with a lower id', async () => {
    // 'z' creates the room; 'a' joins. 'a' sorts lower, which is exactly the
    // case the old min-id election got wrong.
    const host = await peer('z', { claimHost: true });
    expect(host.isHost()).toBe(true);

    const joiner = await peer('a');
    connect('z', 'a');

    expect(host.isHost()).toBe(true);
    expect(joiner.isHost()).toBe(false);
    expect(joiner.host()).toBe('z');
  });

  it('settles a joiner onto the incumbent rather than making it wait out a timer', async () => {
    await peer('z', { claimHost: true });
    const joiner = await peer('a');
    expect(joiner.hostSettled()).toBe(false); // nothing heard yet

    connect('z', 'a');
    expect(joiner.hostSettled()).toBe(true);
    expect(joiner.host()).toBe('z');
  });

  it('keeps the incumbent across many joins, whatever their ids', async () => {
    const host = await peer('m', { claimHost: true });
    for (const id of ['a', 'b', 'z', 'c']) {
      await peer(id);
      connect('m', id);
    }
    expect(host.isHost()).toBe(true);
    expect(wire.peers.size).toBe(5);
  });
});

describe('host election — nobody hosts a mesh that has not formed', () => {
  it('a joiner is NOT host while it has heard nothing', async () => {
    const joiner = await peer('a');
    // This is the "both of us are host, alone" symptom. Before the fix this
    // peer would already be claiming the room.
    expect(joiner.isHost()).toBe(false);
    expect(joiner.hostSettled()).toBe(false);
    expect(joiner.host()).toBeNull();
  });

  it('two peers who cannot see each other do NOT both act as host', async () => {
    const a = await peer('a');
    const b = await peer('b');
    // No connect() — the mesh never formed, exactly the reported failure.
    expect([a.isHost(), b.isHost()]).toEqual([false, false]);
  });

  it('falls back to an election if the room turns out to have no host', async () => {
    const a = await peer('a');
    const b = await peer('b');
    connect('a', 'b');
    // Neither claimed (both arrived via a link into an empty room). They must
    // not deadlock waiting for an incumbent that does not exist.
    vi.advanceTimersByTime(2600);
    expect(a.isHost()).toBe(true); // min-id, agreed by both
    expect(b.isHost()).toBe(false);
    expect(b.host()).toBe('a');
  });

  it('settles the creator immediately so "Create a room" is not a 2.5s wait', async () => {
    const host = await peer('z', { claimHost: true });
    expect(host.hostSettled()).toBe(true);
    expect(host.isHost()).toBe(true);
  });
});

describe('host election — handover happens only on leave', () => {
  it('promotes exactly one survivor when the host leaves', async () => {
    const host = await peer('m', { claimHost: true });
    const b = await peer('b');
    const c = await peer('c');
    connect('m', 'b');
    connect('m', 'c');
    connect('b', 'c');
    expect([b.isHost(), c.isHost()]).toEqual([false, false]);

    await host.leave();

    // min-id among the survivors — both must reach the same answer alone.
    expect(b.isHost()).toBe(true);
    expect(c.isHost()).toBe(false);
    expect(c.host()).toBe('b');
  });

  it('does not reshuffle when a NON-host leaves', async () => {
    const host = await peer('m', { claimHost: true });
    const b = await peer('b');
    const c = await peer('c');
    connect('m', 'b');
    connect('m', 'c');
    connect('b', 'c');

    await c.leave();

    expect(host.isHost()).toBe(true);
    expect(b.isHost()).toBe(false);
    expect(b.host()).toBe('m');
  });

  it('converges when two peers each believe they host the room', async () => {
    // Same code minted twice, or a partition healing. Both apply one rule.
    const z = await peer('z', { claimHost: true });
    const a = await peer('a', { claimHost: true });
    expect([z.isHost(), a.isHost()]).toEqual([true, true]); // alone, both right

    connect('z', 'a');

    // Exactly one survives the meeting, and they agree which.
    expect([z.isHost(), a.isHost()]).toEqual([false, true]);
    expect(z.host()).toBe('a');
    expect(a.host()).toBe('a');
  });

  it('stops announcing once it is no longer host', async () => {
    const z = await peer('z', { claimHost: true });
    const a = await peer('a', { claimHost: true });
    connect('z', 'a');
    expect(z.isHost()).toBe(false);

    // A demoted host that kept announcing would fight the real one forever.
    vi.advanceTimersByTime(6000);
    expect(a.isHost()).toBe(true);
    expect(z.host()).toBe('a');
  });
});
