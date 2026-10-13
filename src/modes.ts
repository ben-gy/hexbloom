// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — the shapes a round can take.
 *
 * Two knobs, moved together: how big the honeycomb is, and how many colours it
 * is painted in. Neither is a difficulty dial — together they change what a move
 * is WORTH.
 *
 * The measured thing (200 AI games per mode per seat count, tests/modes.test.ts):
 *
 *            tiles   moves/game   bloom/move   share of board   lead@3 holds
 *   Skirmish    49         14.4         3.26            6.65%            61%
 *   Bloom       81         22.7         3.48            4.29%            63%
 *   Wilds      143         32.2         4.37            3.06%            56%
 *
 * Read the last two columns, not the middle one. A bloom on Wilds is BIGGER in
 * tiles than a bloom on Skirmish — bigger board, more of everything — but it is
 * less than half as much of the board. That is the whole difference: on Skirmish
 * a single pick moves 1/15th of the game and it is over in fourteen moves, so you
 * take what is in front of you and the four colours mean it is a colour your
 * rival wanted. On Wilds a pick is a nudge across thirty-two moves, so the game
 * is spent lining patches up for high tide.
 *
 * I had this backwards when I wrote the first draft — I assumed few colours meant
 * big blooms, and the sim said the opposite: colour count barely moves bloom size
 * at all, board size does. Hexbloom has form here; see the TIDE_START comment in
 * game.ts. Nothing above is reasoned, all of it is sat in a test.
 *
 * The tide constants are functions of PLAYER count, not board size, and were
 * tuned on 9x9 alone. They hold: no mode blows out, and the first seat wins
 * 45-53% at 2P on every one of them. That is asserted, not assumed — a new size
 * that snowballs is exactly the bug balance.test.ts exists to catch.
 *
 * The host picks; the choice travels frozen inside the round start (see
 * engine/rematch.ts), so every peer builds the same honeycomb. A mode each peer
 * read from its own UI is a mode two peers can disagree about.
 */

export interface Mode {
  id: ModeId;
  name: string;
  /** Grid width and height. game.ts generates and plays any size. */
  w: number;
  h: number;
  /**
   * How many colours the board is painted in. Must be >= 4 (the max seats each
   * need a distinct starting colour) and <= TILE_COLORS.length in render.ts —
   * there is no colour to paint a 8th with. Pinned by a test.
   */
  colors: number;
  /** One line, shown under the name — say what it FEELS like, not the numbers. */
  blurb: string;
}

export type ModeId = 'skirmish' | 'bloom' | 'wilds';

export const MODES: Record<ModeId, Mode> = {
  skirmish: {
    id: 'skirmish',
    name: 'Skirmish',
    w: 7,
    h: 7,
    colors: 4,
    blurb: 'Tight and quick. Four colours — every pick is one they wanted.',
  },
  bloom: {
    id: 'bloom',
    name: 'Bloom',
    w: 9,
    h: 9,
    colors: 6,
    blurb: 'The honeycomb as it was drawn. Grab, or wait for the tide.',
  },
  wilds: {
    id: 'wilds',
    name: 'Wilds',
    w: 13,
    h: 11,
    colors: 7,
    blurb: 'A wide, patchy board. No single move wins it — play for high tide.',
  },
};

export const DEFAULT_MODE: ModeId = 'bloom';

export const MODE_LIST: Mode[] = [MODES.skirmish, MODES.bloom, MODES.wilds];

/**
 * Resolve a mode id that arrived over the wire or out of storage.
 *
 * Never trust it: an older peer, a corrupted store or a hand-edited message
 * would otherwise hand `undefined` to generateBoard, which spreads it through
 * `new Array(w * h)` into a board of NaN tiles rather than throwing anywhere
 * useful. Falling back keeps a mismatched peer playing Bloom instead.
 *
 * hasOwn, NOT a plain `MODES[id] || …`: MODES is an object literal, so it
 * inherits from Object.prototype and `MODES['constructor']` is the Object
 * function — truthy, so it sails through the guard and gets returned AS a Mode
 * with every field undefined. That is the exact NaN board this function exists
 * to prevent, reached by the one input it exists to distrust. Same for
 * 'toString', 'valueOf' and friends. Pinned by tests/modes.test.ts.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id as ModeId];
  return MODES[DEFAULT_MODE];
}
