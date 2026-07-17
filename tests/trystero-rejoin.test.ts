/**
 * trystero-rejoin.test.ts — a CHARACTERIZATION test.
 *
 * It does not test our code. It pins down the exact Trystero behaviour that
 * caused the "we're both the host and can't see each other" bug, so that:
 *   a) the hazard is written down as executable fact, not folklore in a comment;
 *   b) a `npm update trystero` that changes this behaviour turns this red and
 *      makes someone re-read engine/net.ts before shipping.
 *
 * The bug, in one line: joinRoom is memoized on appId+roomId, but leave() is
 * async and defers its teardown behind a ~99ms timer — so leave-then-rejoin in
 * the same tick hands you back the room that is about to be destroyed.
 *
 * No network: Trystero builds the room object synchronously and only touches
 * relays through fire-and-forget promises, so stubbed WebRTC/WebSocket globals
 * that never connect are enough to exercise the whole cache + teardown path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinRoom } from 'trystero';

/** A socket that never opens, never closes, and never retries. */
class DeadSocket {
  readyState = 0;
  url: string;
  onclose: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** jsdom has no WebRTC. Trystero pre-allocates offer peers on join, so it needs
 *  a connection object that gathers no candidates and resolves nothing. */
class DeadPeerConnection {
  iceGatheringState = 'new';
  localDescription = null;
  createDataChannel(): Record<string, unknown> {
    return {};
  }
  createOffer(): Promise<Record<string, unknown>> {
    return new Promise(() => {});
  }
  setLocalDescription(): Promise<void> {
    return new Promise(() => {});
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const APP = 'hexbloom-test';

beforeEach(() => {
  vi.stubGlobal('WebSocket', DeadSocket);
  vi.stubGlobal('RTCPeerConnection', DeadPeerConnection);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trystero room lifecycle (pinned behaviour, v0.21.x)', () => {
  it('memoizes joinRoom on appId+roomId — a second join returns the SAME object', () => {
    const a = joinRoom({ appId: APP }, 'MEMO');
    const b = joinRoom({ appId: APP }, 'MEMO');

    // Not a bug on its own — it is why "rejoining to reset" silently no-ops
    // instead of giving you the fresh room the calling code assumes it got.
    expect(b).toBe(a);

    return a.leave();
  });

  it('THE TRAP: rejoining in the same tick as leave() returns the DYING room', async () => {
    const first = joinRoom({ appId: APP }, 'TRAP');

    // Fire-and-forget, exactly as the old net.ts leave() did.
    const leaving = first.leave();
    const rejoined = joinRoom({ appId: APP }, 'TRAP');

    // The room is still in Trystero's cache because leave() has not reached its
    // teardown yet. This identity is the entire bug: the "new" Net wraps a room
    // whose relay subscription and announce timer are about to be torn down, so
    // it can never see a peer again and elects itself host forever.
    expect(rejoined).toBe(first);

    await leaving;
  });

  it('is safe once leave() has resolved — that is why net.leave() must be awaited', async () => {
    const first = joinRoom({ appId: APP }, 'SAFE');
    await first.leave();

    const second = joinRoom({ appId: APP }, 'SAFE');
    expect(second).not.toBe(first);

    await second.leave();
  });

  it('defers teardown well past the current tick (the window the trap lives in)', async () => {
    const room = joinRoom({ appId: APP }, 'SLOW');
    let settled = false;
    const leaving = room.leave().then(() => {
      settled = true;
    });

    // A microtask flush is not enough — leave() awaits a real ~99ms timer, so
    // any synchronous `leave(); join()` pair lands inside the window.
    await Promise.resolve();
    expect(settled).toBe(false);

    await leaving;
    expect(settled).toBe(true);
  });
});
