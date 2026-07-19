/**
 * mobile.test.ts — the zoom guard.
 *
 * A real player double-tapped mid-game, zoomed into the board, and had no way
 * back out. The viewport meta says user-scalable=no; iOS Safari has ignored that
 * since iOS 10, so the guard has to be code. That makes it testable, and this is
 * the only place the behaviour is pinned: assert the events are actually
 * cancelled, not merely that a listener was added.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { hardenViewport } from '@ben-gy/game-engine/mobile';

/** Dispatch a cancelable event and report whether the guard refused it. */
function fire(type: string, init: Record<string, unknown> = {}): boolean {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, init);
  document.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('hardenViewport', () => {
  let unharden: () => void;
  beforeEach(() => {
    document.documentElement.style.removeProperty('--vh');
  });

  it('refuses the iOS pinch gestures', () => {
    unharden = hardenViewport();
    // gesturestart/change/end are Safari-only and the ONLY way to refuse a pinch.
    expect(fire('gesturestart')).toBe(true);
    expect(fire('gesturechange')).toBe(true);
    expect(fire('gestureend')).toBe(true);
    unharden();
  });

  it('refuses a two-finger touchmove but lets a one-finger drag through', () => {
    unharden = hardenViewport();
    expect(fire('touchmove', { touches: { length: 2 } })).toBe(true);
    // A single touch is a player picking a colour — blocking it would break the game.
    expect(fire('touchmove', { touches: { length: 1 } })).toBe(false);
    unharden();
  });

  it('refuses the second tap of a double-tap, but not two separate taps', () => {
    unharden = hardenViewport();
    expect(fire('touchend')).toBe(false); // first tap
    expect(fire('touchend')).toBe(true); // inside the double-tap window → zoom
    expect(fire('dblclick')).toBe(true);
    unharden();
  });

  it('publishes --vh, and never writes the 0 a backgrounded tab reports', () => {
    const el = document.documentElement;
    unharden = hardenViewport();
    expect(el.style.getPropertyValue('--vh')).toBe(`${window.innerHeight * 0.01}px`);

    const good = el.style.getPropertyValue('--vh');
    (window as { innerHeight: number }).innerHeight = 0;
    window.dispatchEvent(new Event('resize'));
    // A 0px --vh would collapse every calc(var(--vh) * 100) to a blank page.
    expect(el.style.getPropertyValue('--vh')).toBe(good);
    unharden();
  });

  it('detaches cleanly, so a torn-down screen stops eating gestures', () => {
    hardenViewport()();
    expect(fire('gesturestart')).toBe(false);
    expect(fire('touchmove', { touches: { length: 2 } })).toBe(false);
  });
});
