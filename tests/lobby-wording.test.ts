/**
 * lobby-wording.test.ts — the two strings this game kept a 645-line forked
 * lobby for.
 *
 * The fork's only user-visible divergence from the shared engine was wording:
 * a share sheet that said "Join my Hexbloom game" instead of "Join my game",
 * and a Start button that said "Start game" instead of "Start now". Engine
 * v1.4.0 added `share` and `labels` so the fork could be deleted.
 *
 * Both halves are pinned here, and the source-level half is the load-bearing
 * one. Dropping `share:` or `labels:` from the createLobby call in main.ts is
 * SILENT — the engine falls back to its own defaults, everything compiles,
 * every other test stays green, and the only symptom is a generic invite on a
 * player's phone. A DOM test that builds its own config cannot see that: it
 * would be asserting against itself.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLobby } from '@ben-gy/game-engine/lobby';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
import type { Rounds, RoundsState } from '@ben-gy/game-engine/rematch';

const SHARE_TITLE = 'Join my Hexbloom game';
const START_LABEL = 'Start game';

function fakeNet(selfId: PeerId = 'me'): Net {
  return {
    selfId,
    peers: () => [selfId, 'them'],
    host: () => selfId,
    isHost: () => true,
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
      host: selfId,
      epoch: 1,
      settled: true,
      peers: [selfId, 'them'],
      relaySockets: {},
      turn: true,
    }),
  };
}

function fakeRounds(initial: Partial<RoundsState> = {}): Rounds {
  const s: RoundsState = {
    round: 0,
    phase: 'waiting',
    votes: [],
    present: [
      { id: 'me', name: 'Me' },
      { id: 'them', name: 'Them' },
    ],
    voted: false,
    isHost: true,
    canStart: true,
    seated: true,
    hostOpts: null,
    startsInMs: null,
    ...initial,
  };
  return {
    vote: () => {},
    unvote: () => {},
    go: () => {},
    finish: () => {},
    state: () => s,
    destroy: () => {},
  };
}

let container: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('the lobby wording main.ts asks the engine for', () => {
  it('is actually passed at the createLobby call site', () => {
    // The silent-drop guard. Everything below this test would still pass if
    // main.ts stopped asking for these, because the engine has defaults.
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main, 'main.ts must pass share.title or the invite sheet goes generic').toContain(
      `share: { title: '${SHARE_TITLE}' }`,
    );
    expect(main, 'main.ts must pass labels.start or the button reads "Start now"').toContain(
      `labels: { start: '${START_LABEL}' }`,
    );
  });

  it('puts the game name in the share sheet', async () => {
    const shared: ShareData[] = [];
    Object.defineProperty(navigator, 'share', {
      value: async (d: ShareData) => {
        shared.push(d);
      },
      configurable: true,
      writable: true,
    });

    createLobby({
      container,
      net: fakeNet(),
      rounds: fakeRounds(),
      roomCode: 'QK7P',
      share: { title: SHARE_TITLE },
    });
    container.querySelector<HTMLElement>('.lobby-share')!.click();
    // Drain share()'s microtasks. NOT runAllTimersAsync — the lobby polls itself
    // on an interval that never ends.
    await vi.advanceTimersByTimeAsync(1);

    expect(shared).toHaveLength(1);
    expect(shared[0].title).toBe(SHARE_TITLE);
    expect(shared[0].text, 'the room code still rides along').toBe('Room QK7P');
  });

  it('names the host button "Start game"', () => {
    createLobby({
      container,
      net: fakeNet(),
      rounds: fakeRounds(),
      roomCode: 'QK7P',
      labels: { start: START_LABEL },
    });
    expect(container.querySelector('.lobby-start')!.textContent!.trim()).toBe(START_LABEL);
  });
});
