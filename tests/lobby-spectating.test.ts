/**
 * lobby-spectating.test.ts — what an UNSEATED peer sees while a round runs.
 *
 * This is the last mile of 01-DIAGNOSIS §3, the "I got ejected" failure. Engine
 * v1.1.0 fixes the protocol half — the host no longer freezes a roster out of a
 * half-formed mesh, and a late connector gets the live round re-sent to it — but
 * a peer can still legitimately arrive mid-round, and `RoundInfo.seated` tells
 * it so. What the PLAYER experiences at that moment is the view's problem, and
 * hexbloom keeps its own fork of the engine's lobby (for public rooms and the
 * mode picker), so the engine's own coverage does not reach this code.
 *
 * Before this, the fork bailed out of render() on phase 'playing' and nothing
 * else painted the container: an unseated player got a blank screen with no
 * ready button and no way back into the game. That is not a cosmetic bug — it is
 * the entire reported symptom, reproduced faithfully after the netcode was
 * fixed. So it is asserted here directly, against the real render path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLobby } from '../src/engine/lobby';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
import type { Rounds, RoundsState } from '@ben-gy/game-engine/rematch';

function fakeNet(selfId: PeerId = 'me'): Net {
  return {
    selfId,
    peers: () => [selfId, 'them'],
    host: () => 'them',
    isHost: () => false,
    hostSettled: () => true,
    count: () => 2,
    channel: (() => {
      const send = (() => {}) as never;
      (send as unknown as { off: () => void }).off = () => {};
      return send;
    }) as unknown as Net['channel'],
    ping: async () => 0,
    leave: async () => {},
    hostEpoch: () => 1,
    onPeersChange: () => () => {},
    takeover: () => {},
    netDiag: () => ({
      selfId,
      host: 'them',
      epoch: 1,
      settled: true,
      peers: [selfId, 'them'],
      relaySockets: {},
      turn: true,
    }),
  };
}

/** A Rounds whose state the test drives directly — the view is what's under test. */
function fakeRounds(initial: Partial<RoundsState> = {}): Rounds & { set(p: Partial<RoundsState>): void } {
  let s: RoundsState = {
    round: 3,
    phase: 'playing',
    votes: [],
    present: [
      { id: 'me', name: 'Me' },
      { id: 'them', name: 'Them' },
    ],
    voted: false,
    isHost: false,
    canStart: false,
    seated: false,
    hostOpts: null,
    startsInMs: null,
    ...initial,
  };
  return {
    state: () => s,
    vote: () => {
      s = { ...s, voted: true };
    },
    unvote: () => {
      s = { ...s, voted: false };
    },
    go: () => {},
    finish: () => {},
    destroy: () => {},
    set(p: Partial<RoundsState>) {
      s = { ...s, ...p };
    },
  };
}

function mount(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = mount();
});

describe('lobby — a round is running and we are not in it', () => {
  it('shows an honest status instead of a blank screen', () => {
    const rounds = fakeRounds({ seated: false, round: 3 });
    const view = createLobby({ container, net: fakeNet(), rounds, roomCode: 'ABCD' });

    // The bug was an EMPTY container. Assert there is something, and that it
    // says the true thing: a round is on, and we are queued for the next.
    expect(container.textContent?.trim()).not.toBe('');
    expect(container.querySelector('.lobby-spectating')).not.toBeNull();
    expect(container.textContent).toContain('Round 3 in progress');
    expect(container.textContent).toContain("You're in the next one");

    view.destroy();
  });

  it('gives the unseated player a live ready toggle for the next round', () => {
    const rounds = fakeRounds({ seated: false });
    const voteSpy = vi.spyOn(rounds, 'vote');
    const view = createLobby({ container, net: fakeNet(), rounds, roomCode: 'ABCD' });

    const ready = container.querySelector<HTMLButtonElement>('.lobby-ready');
    // Without this button the player waits out the round and is excluded from
    // the next one too — the ejection made permanent.
    expect(ready).not.toBeNull();
    expect(ready!.textContent).toContain('Ready me for the next round');

    ready!.click();
    expect(voteSpy).toHaveBeenCalled();
    // …and the button reflects it, so the tap is not silently swallowed.
    expect(container.querySelector('.lobby-ready')?.textContent).toContain(
      "You're in for the next round",
    );

    view.destroy();
  });

  it('offers a way out of the room', () => {
    const onCancel = vi.fn();
    const view = createLobby({
      container,
      net: fakeNet(),
      rounds: fakeRounds({ seated: false }),
      roomCode: 'ABCD',
      onCancel,
    });

    container.querySelector<HTMLButtonElement>('.lobby-cancel')!.click();
    expect(onCancel).toHaveBeenCalled();

    view.destroy();
  });

  it('keeps its hands off the screen when we ARE seated', () => {
    // The game owns the container during a round we are playing. A lobby that
    // painted here would wipe the board mid-move.
    const view = createLobby({
      container,
      net: fakeNet(),
      rounds: fakeRounds({ seated: true }),
      roomCode: 'ABCD',
    });

    expect(container.innerHTML).toBe('');

    view.destroy();
  });

  it('paints the normal lobby again once the round ends', () => {
    const rounds = fakeRounds({ seated: false });
    const view = createLobby({ container, net: fakeNet(), rounds, roomCode: 'ABCD' });
    expect(container.querySelector('.lobby-spectating')).not.toBeNull();

    // The round finishes; the spectator is a full lobby member again, not stuck
    // on a "waiting" screen that never clears.
    rounds.set({ phase: 'waiting', seated: false });
    view.repaint();

    expect(container.querySelector('.lobby-spectating')).toBeNull();
    expect(container.textContent).toContain('ABCD');

    view.destroy();
  });
});
