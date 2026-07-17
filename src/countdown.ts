/**
 * countdown.ts — the three seconds between "everyone's ready" and the first move.
 *
 * Hexbloom is turn-based, so this is not about reflexes: nobody can lose a tile
 * to a slow start. It buys the thing a turn-based board actually needs, which is
 * a look. The honeycomb is generated fresh and it is the whole game — where the
 * big patches are, which corner is yours, who you are wedged against. A board
 * that simply appears with a live palette on it makes the first pick the one move
 * nobody got to think about, and on Skirmish the first pick is a fifteenth of the
 * game. So the board renders behind the count and the palette stays dead until
 * GO (see setLocked in main.ts) — everyone gets the same look at it.
 *
 * The audio matters more than the number. Players are looking at the grid, not
 * the overlay, so the pips are what actually starts the round for them: three
 * rising ticks and a higher GO. That is also why the tick fires on the same frame
 * the digit changes rather than on its own timer — a countdown whose sound lags
 * its number feels broken in a way people notice but cannot name.
 *
 * Every peer runs this locally from the moment the host's start arrives, so they
 * are in step to within one network hop (~50-150ms). Nothing is timed against it,
 * so that skew costs nobody a move.
 */

import type { Sfx } from './engine/sound';

export interface CountdownOptions {
  root: HTMLElement;
  sfx: Sfx;
  /** Ticks to count. Default 3. */
  from?: number;
  reducedMotion?: boolean;
  onDone: () => void;
}

export interface Countdown {
  /** Stop early — a peer that left, or a round torn down mid-count. */
  cancel(): void;
}

export function createCountdown(o: CountdownOptions): Countdown {
  const from = o.from ?? 3;
  let n = from;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const el = document.createElement('div');
  el.className = 'countdown';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'assertive');
  if (o.reducedMotion) el.classList.add('reduced');
  o.root.appendChild(el);

  function paint(text: string, cls: string): void {
    el.innerHTML = `<span class="cd-num ${cls}">${text}</span>`;
  }

  function step(): void {
    if (done) return;
    if (n > 0) {
      paint(String(n), 'cd-tick');
      // Pitch climbs with the count so the ear tracks it without reading.
      o.sfx.play('blip', 1 + (from - n) * 0.15);
      n--;
      timer = setTimeout(step, 1000);
      return;
    }
    paint('GO', 'cd-go');
    o.sfx.play('win');
    timer = setTimeout(() => {
      finish();
      o.onDone();
    }, 450);
  }

  /**
   * Idempotent, and cancel() is why it has to be: a round torn down inside the
   * last 450ms would otherwise fire onDone() from the pending timer — unlocking
   * the palette of a session that has already been destroyed.
   */
  function finish(): void {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    el.remove();
  }

  step();

  return {
    cancel() {
      finish();
    },
  };
}
