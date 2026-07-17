/**
 * countdown.test.ts — the three seconds before the first move.
 *
 * The countdown is small, but it is the only thing between the round start
 * arriving and a live palette, so the two ways it can fail are both nasty and
 * both silent:
 *
 *   - it never finishes, and the board is up but nobody can move — indisinguishable
 *     from a netcode hang;
 *   - it finishes AFTER the round was torn down, and calls onDone() into a
 *     session that no longer exists (main.ts unlocks a destroyed session).
 *
 * The second is why cancel() and the natural end share one idempotent `finish`,
 * and it is what the teardown tests below are actually about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCountdown } from '../src/countdown';
import type { Sfx, SfxName } from '../src/engine/sound';

/** Records what was played, and never touches the Web Audio API. */
function fakeSfx(): Sfx & { played: SfxName[] } {
  const played: SfxName[] = [];
  return {
    played,
    play: (name: SfxName) => void played.push(name),
    setMuted: () => {},
    muted: () => false,
    unlock: () => {},
  } as Sfx & { played: SfxName[] };
}

describe('createCountdown', () => {
  let root: HTMLElement;
  let sfx: ReturnType<typeof fakeSfx>;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.append(root);
    sfx = fakeSfx();
  });

  afterEach(() => {
    vi.useRealTimers();
    root.remove();
  });

  it('counts 3 - 2 - 1 - GO and then starts the round', () => {
    const onDone = vi.fn();
    createCountdown({ root, sfx, onDone });

    const num = () => root.querySelector('.cd-num')!.textContent;
    expect(num()).toBe('3');
    vi.advanceTimersByTime(1000);
    expect(num()).toBe('2');
    vi.advanceTimersByTime(1000);
    expect(num()).toBe('1');
    vi.advanceTimersByTime(1000);
    expect(num()).toBe('GO');

    // GO is on screen before the round starts, not instead of it.
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(450);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('takes itself off the board when it is done', () => {
    createCountdown({ root, sfx, onDone: () => {} });
    vi.advanceTimersByTime(4000);
    // Left behind, it is a fixed overlay sitting over a live board.
    expect(root.querySelector('.countdown')).toBeNull();
  });

  it('pips every tick and lands GO on a different sound', () => {
    createCountdown({ root, sfx, onDone: () => {} });
    vi.advanceTimersByTime(3000);
    // Players are looking at the honeycomb, not the number — the sound is what
    // actually starts the round for them.
    expect(sfx.played).toEqual(['blip', 'blip', 'blip', 'win']);
  });

  it('honours a shorter count', () => {
    const onDone = vi.fn();
    createCountdown({ root, sfx, from: 1, onDone });
    expect(root.querySelector('.cd-num')!.textContent).toBe('1');
    vi.advanceTimersByTime(1000 + 450);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('announces itself to a screen reader', () => {
    createCountdown({ root, sfx, onDone: () => {} });
    const el = root.querySelector('.countdown')!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('assertive');
  });

  it('drops the animation when the player asked for less motion', () => {
    createCountdown({ root, sfx, reducedMotion: true, onDone: () => {} });
    expect(root.querySelector('.countdown')!.classList.contains('reduced')).toBe(true);
  });

  describe('cancel', () => {
    it('never starts the round, and clears the overlay', () => {
      const onDone = vi.fn();
      const cd = createCountdown({ root, sfx, onDone });
      vi.advanceTimersByTime(1000);
      cd.cancel();

      expect(root.querySelector('.countdown')).toBeNull();
      vi.advanceTimersByTime(5000);
      // A peer that left mid-count. Firing onDone here unlocks the palette of a
      // session main.ts has already destroyed.
      expect(onDone).not.toHaveBeenCalled();
    });

    it('still holds inside the last 450ms, after GO is showing', () => {
      const onDone = vi.fn();
      const cd = createCountdown({ root, sfx, onDone });
      // The gap between GO and the round starting is a real window with its own
      // pending timer — the one place a naive cancel would miss.
      vi.advanceTimersByTime(3000);
      expect(root.querySelector('.cd-num')!.textContent).toBe('GO');
      cd.cancel();
      vi.advanceTimersByTime(1000);
      expect(onDone).not.toHaveBeenCalled();
    });

    it('is safe to call twice, and after it has already finished', () => {
      const onDone = vi.fn();
      const cd = createCountdown({ root, sfx, onDone });
      vi.advanceTimersByTime(4000);
      expect(onDone).toHaveBeenCalledTimes(1);
      // main.ts cancels on every teardown path without asking whether the count
      // already ended — leaveRoom() runs on the way out of a finished round too.
      expect(() => {
        cd.cancel();
        cd.cancel();
      }).not.toThrow();
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });
});
