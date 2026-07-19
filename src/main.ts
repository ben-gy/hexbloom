/**
 * main.ts — Hexbloom bootstrap and orchestration. Owns the screen router, the
 * solo (vs-AI) and multiplayer (P2P) drivers, and the in-game session that turns
 * state updates into board paint + particles + sound. Heavy rules live in
 * game.ts; netcode in net-game.ts; rendering in render.ts.
 */

// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './styles/mobile.css';
import './styles/main.css';
import { hardenViewport } from '@ben-gy/game-engine/mobile';
import {
  applyMove,
  bloomReach,
  captureCount,
  chooseAiColor,
  generateBoard,
  scores,
  TIDE_EVERY,
  winners,
  type Difficulty,
  type GameState,
} from './game';
import { newSeed } from '@ben-gy/game-engine/rng';
import { createSfx } from './engine/sound';
import { createStore } from '@ben-gy/game-engine/storage';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type RoundPlayer, type Rounds } from '@ben-gy/game-engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createListing,
  createRoomEntry,
  normalizeRoomCode,
  setRoomInUrl,
  P2P_IP_NOTE,
  type BoardAccess,
  type Listing,
} from './engine/lobby';
import { createNoticeboard, type Noticeboard, type PublicRoom } from '@ben-gy/game-engine/noticeboard';
import { createCountdown } from './countdown';
import { DEFAULT_MODE, MODE_LIST, modeOf, type Mode, type ModeId } from './modes';
import { NetGame } from './net-game';
import { BoardView, PLAYER_ACCENTS, TILE_COLORS } from './render';
import {
  ABOUT_HTML,
  escapeHtml,
  FOOTER_HTML,
  HOWTO_HTML,
  menuHTML,
  openModal,
  soloSetupHTML,
} from './ui';

const APP_ID = 'hexbloom';
/**
 * The appId every mesh on this page joins with. `roomAppId` stamps the protocol
 * revision onto the slug so a future wire-format change partitions old builds
 * automatically instead of letting them into a room they cannot speak in. The
 * noticeboard keys off the same appId, so it gets the stamped one too.
 *
 * NOTE this is not the storage namespace — `createStore` keeps the bare slug, or
 * a protocol bump would silently orphan every player's saved settings.
 */
const ROOM_APP_ID = roomAppId(APP_ID);
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const RIVAL_NAMES = ['Vero', 'Cyra', 'Juno'];
const NAME_POOL = ['Fox', 'Wren', 'Sage', 'Koi', 'Lark', 'Bea', 'Nova', 'Pip', 'Ozzy', 'Rio'];

/**
 * TURN credentials for EVERY mesh this page opens, fetched once at boot.
 *
 * This has to happen before the first `joinRoom` anywhere on the page, not just
 * before the game room. Trystero builds ONE global pool of pre-made peer
 * connections from whichever room joins FIRST, and every later room draws its
 * outbound offers from that pool — so if the public-rooms noticeboard opens
 * first without TURN, the game room's initiating half stays STUN-only no matter
 * what the game room itself was configured with. That failure is worse than
 * having no TURN at all, because it only affects the roughly half of pairs where
 * Trystero picked the turnless side as initiator.
 *
 * Kicked off here at module load, and awaited at each mesh site below. It is
 * session-cached and fails open to `[]` (plain STUN-only, the old behaviour) on
 * timeout or error, so it can delay a first join by at most its own 3s timeout
 * and can never block one.
 */
const turnReady: Promise<void> = getTurnConfig().then(
  (servers) => setTurnConfig(servers),
  () => setTurnConfig([]),
);

// Before anything renders: iOS ignores the viewport meta's user-scalable=no, so a
// double-tap or pinch would zoom a live board with no way back out.
hardenViewport();

const store = createStore(APP_ID);
const settings = {
  muted: store.get('muted', false),
  symbols: store.get('symbols', false),
};
const sfx = createSfx(settings.muted);
const reducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const app = document.getElementById('app')!;
app.innerHTML = `<main class="main-content" id="content"></main>${FOOTER_HTML}`;
const content = document.getElementById('content')!;

let net: Net | null = null;
let rounds: Rounds | null = null;
let lobbyView: { destroy: () => void; repaint: () => void } | null = null;
let roomEntry: { destroy: () => void } | null = null;
let activeNetGame: NetGame | null = null;
let session: GameSession | null = null;
let countdown: { cancel: () => void } | null = null;
let listing: Listing | null = null;
let listingTick: ReturnType<typeof setInterval> | undefined;
/** The room we are in, and whether it is on the public list. Private by default. */
let roomCode = '';
let roomPublic = false;

/** The mode this player last chose. The HOST's choice is what a room plays. */
let modeId: ModeId = modeOf(store.get<string>('mode', DEFAULT_MODE)).id;

function setMode(id: ModeId): void {
  modeId = modeOf(id).id;
  store.set('mode', modeId);
}

/** A ?room= in the URL (an invite link) is honoured once; after that "Play with
 *  friends" shows the create/join screen, so the link is never the only way in. */
let pendingRoom: string | null = (() => {
  const c = normalizeRoomCode(new URL(location.href).searchParams.get('room') ?? '');
  return c.length >= 3 ? c : null;
})();

/** Resolves once any in-flight room teardown has fully finished. */
let roomTeardown: Promise<void> = Promise.resolve();

// Unlock audio on the first gesture (browsers block it until then).
const unlockOnce = () => {
  sfx.unlock();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
};
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);

window.addEventListener('beforeunload', () => {
  try {
    net?.leave();
  } catch {
    /* ignore */
  }
});

function playerName(): string {
  let n = store.get<string>('name', '');
  if (!n) {
    n = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
    store.set('name', n);
  }
  return n;
}


// ---------------------------------------------------------------------------
// Mode picker — the host's pick is the room's pick.
// ---------------------------------------------------------------------------

function modePicker(): string {
  const m = modeOf(modeId);
  return `
    <div class="modes" role="radiogroup" aria-label="Board">
      ${MODE_LIST.map(
        (x) => `<button class="mode-chip${x.id === m.id ? ' on' : ''}" type="button"
          role="radio" aria-checked="${x.id === m.id}" data-mode="${x.id}">
          <span class="mode-name">${escapeHtml(x.name)}</span>
          <span class="mode-meta">${x.w}×${x.h} · ${x.colors} colours</span>
        </button>`,
      ).join('')}
      <p class="mode-blurb">${escapeHtml(m.blurb)}</p>
    </div>`;
}

function modeNote(): string {
  // The HOST's gossiped choice — never our own local pick. Rendering `modeId`
  // here would confidently tell a guest "Host picked Skirmish" while the host
  // was actually setting up a 13×11 Wilds.
  const hostOpts = rounds?.state().hostOpts as { mode?: unknown; pub?: unknown } | null | undefined;
  if (hostOpts == null) return `<p class="mode-note">Waiting for the host’s pick…</p>`;
  const m = modeOf(hostOpts.mode);
  return (
    `<p class="mode-note">Host picked <strong>${escapeHtml(m.name)}</strong> · ${m.w}×${m.h} · ${
      m.colors
    } colours</p>` +
    // Someone who was handed an invite link has no way of knowing strangers can
    // walk in unless we say so.
    (hostOpts.pub
      ? `<p class="mode-note pub">This room is listed publicly — anyone browsing can join.</p>`
      : '')
  );
}

function wireModePicker(repaint: () => void): void {
  for (const btn of content.querySelectorAll<HTMLButtonElement>('.mode-chip')) {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.mode as ModeId);
      sfx.play('blip');
      repaint();
    });
  }
}

// ---------------------------------------------------------------------------
// Public / private.
// ---------------------------------------------------------------------------

/** The host's own control, in the lobby: a room can be taken off the list again. */
function visibilityPicker(): string {
  const chip = (pub: boolean, name: string, meta: string): string =>
    `<button class="vis-chip${roomPublic === pub ? ' on' : ''}" type="button"
      role="radio" aria-checked="${roomPublic === pub}" data-pub="${pub ? 1 : 0}">
      <span class="vis-name">${escapeHtml(name)}</span>
      <span class="vis-meta">${escapeHtml(meta)}</span>
    </button>`;
  return `
    <div class="vis" role="radiogroup" aria-label="Who can join">
      ${chip(false, 'Private', 'Invite only')}
      ${chip(true, 'Public', 'Listed for anyone')}
    </div>
    <p class="re-note">${escapeHtml(P2P_IP_NOTE)}</p>`;
}

function wireVisibility(repaint: () => void): void {
  for (const btn of content.querySelectorAll<HTMLButtonElement>('.vis-chip')) {
    btn.addEventListener('click', () => {
      roomPublic = btn.dataset.pub === '1';
      sfx.play('blip');
      // Immediately, not on the next tick: "private" has to mean off the list
      // now, not within a second.
      syncListing();
      repaint();
    });
  }
}

// ---------------------------------------------------------------------------
// The public room list.
//
// At most one board, held only while something is actually using it — browsing
// the list, or listing our own room. It is a mesh of STRANGERS (see P2P_IP_NOTE),
// so it is never opened by the page loading and never left running behind a
// screen the player has walked away from.
// ---------------------------------------------------------------------------

let board: Noticeboard | null = null;
let boardRooms: ((rooms: PublicRoom[]) => void) | null = null;
/** Serialises open/close. net.ts throws if the board's room is rejoined while the
 *  last one is still tearing down, and browse → back → browse is two taps. */
let boardQueue: Promise<void> = Promise.resolve();

function onBoard(then: () => void): Promise<void> {
  boardQueue = boardQueue
    // The board can be the first mesh on the page, so it must not open before the
    // shared TURN config is in force — see `turnReady`.
    .then(() => turnReady)
    .then(() => {
      board ??= createNoticeboard({ appId: ROOM_APP_ID, onRooms: (r) => boardRooms?.(r) });
      then();
    })
    .then(
      () => undefined,
      (e) => console.error(e),
    );
  return boardQueue;
}

const boardAccess: BoardAccess = {
  open(onRooms) {
    boardRooms = onRooms;
    // Hand over whatever is already known so the list is not blank for a cycle.
    return onBoard(() => onRooms(board!.rooms()));
  },
  announce(ad) {
    return onBoard(() => board!.announce(ad));
  },
  close() {
    boardRooms = null;
    const b = board;
    board = null;
    if (!b) return;
    // CHAIN, never replace — same trap as roomTeardown below.
    boardQueue = boardQueue.then(() => b.destroy()).then(
      () => undefined,
      () => undefined,
    );
  },
};

/** Feed engine/lobby.ts's roomAd() rule the room's current truth. It decides. */
function syncListing(): void {
  if (!listing) return;
  if (!net || !rounds) {
    listing.close();
    return;
  }
  const s = rounds.state();
  listing.sync({
    isPublic: roomPublic,
    isHost: net.isHost(),
    inLobby: !!lobbyView,
    playing: s.phase === 'playing',
    code: roomCode,
    host: playerName(),
    players: s.present.length,
    max: MAX_PLAYERS,
    note: modeOf(modeId).name,
  });
}

// ---------------------------------------------------------------------------
// Drivers: a common surface for solo and multiplayer games.
// ---------------------------------------------------------------------------

type UpdateCb = (state: GameState, meta: { absorbed: number[]; mover: number }) => void;

interface Driver {
  mode: 'solo' | 'mp';
  getState(): GameState;
  myPlayer(): number;
  isMyTurn(): boolean;
  play(color: number): void;
  setUpdate(cb: UpdateCb): void;
  names(): string[];
  start(): void;
  restart?(): void;
  destroy(): void;
}

class SoloDriver implements Driver {
  readonly mode = 'solo' as const;
  private state: GameState;
  private cb: UpdateCb = () => {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _names: string[];

  constructor(private opts: { rivals: number; difficulty: Difficulty; mode: Mode }) {
    this.state = this.fresh();
    this._names = ['You', ...RIVAL_NAMES.slice(0, opts.rivals)];
  }

  private fresh(): GameState {
    const { w, h, colors } = this.opts.mode;
    return generateBoard(newSeed(), { w, h, colors, players: this.opts.rivals + 1 });
  }

  getState() {
    return this.state;
  }
  myPlayer() {
    return 0;
  }
  isMyTurn() {
    return !this.state.finished && this.state.turn === 0;
  }
  names() {
    return this._names;
  }
  setUpdate(cb: UpdateCb) {
    this.cb = cb;
  }

  start() {
    this.cb(this.state, { absorbed: [], mover: -1 });
    this.advance();
  }

  play(color: number) {
    if (this.state.turn !== 0 || this.state.finished) return;
    const res = applyMove(this.state, 0, color);
    if (res.state === this.state) return;
    this.state = res.state;
    this.cb(this.state, { absorbed: res.absorbed, mover: 0 });
    this.advance();
  }

  private advance() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.state.finished || this.state.turn === 0) return;
    const seat = this.state.turn;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state.finished || this.state.turn !== seat) return;
      const color = chooseAiColor(this.state, seat, this.opts.difficulty);
      const res = applyMove(this.state, seat, color);
      this.state = res.state;
      this.cb(this.state, { absorbed: res.absorbed, mover: seat });
      this.advance();
    }, 520);
  }

  restart() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = this.fresh();
    this.cb(this.state, { absorbed: [], mover: -1 });
    this.advance();
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

class MpDriver implements Driver {
  readonly mode = 'mp' as const;
  private cb: UpdateCb = () => {};
  private ng!: NetGame;

  constructor(private _names: string[]) {}

  attach(ng: NetGame) {
    this.ng = ng;
  }
  forward(state: GameState, meta: { absorbed: number[]; mover: number }) {
    this.cb(state, meta);
  }

  getState() {
    return this.ng.getState();
  }
  myPlayer() {
    return this.ng.mySeat();
  }
  isMyTurn() {
    return this.ng.isMyTurn();
  }
  names() {
    return this._names;
  }
  setUpdate(cb: UpdateCb) {
    this.cb = cb;
  }
  start() {
    this.cb(this.ng.getState(), { absorbed: [], mover: -1 });
  }
  play(color: number) {
    this.ng.play(color);
  }
  destroy() {
    this.ng?.destroy();
  }
}

// ---------------------------------------------------------------------------
// In-game session: renders HUD + board + palette and reacts to state updates.
// ---------------------------------------------------------------------------

/** Per-player breakdown accumulated over a match, for the results screen. */
interface PlayerStats {
  moves: number;
  taken: number;
  best: number;
}

class GameSession {
  private board: BoardView;
  private onKey: (e: KeyboardEvent) => void;
  private resultsShown = false;
  private stats: PlayerStats[] = [];
  /** Highest turnNo already counted — snapshots can arrive twice (a re-sync
   *  replays the current position), and a double count would inflate the stats. */
  private countedTurn = 0;
  /** Last rendered bloom reach; -1 until the first paint so we don't chime on it. */
  private lastReach = -1;
  /** True while the countdown is running — the board is up, the palette is not. */
  private locked = false;
  private againTick: ReturnType<typeof setInterval> | null = null;

  constructor(private driver: Driver) {
    this.render();
    this.board = new BoardView(document.getElementById('board')!);
    this.board.setSymbols(settings.symbols);
    this.board.build(driver.getState());
    this.resetStats(driver.getState());
    this.driver.setUpdate((s, m) => this.update(s, m));
    this.refresh(driver.getState());
    this.onKey = (e) => this.handleKey(e);
    document.addEventListener('keydown', this.onKey);
    this.driver.start();
  }

  private render() {
    content.innerHTML = `
      <section class="screen game">
        <div class="topbar">
          <button class="icon-btn" data-act="menu">‹ Menu</button>
          <div class="turn-banner" id="turnBanner" role="status" aria-live="polite"></div>
          <button class="icon-btn" data-act="mute" id="muteBtn" aria-label="Toggle sound"></button>
        </div>
        <div class="hud" id="hud"></div>
        <div class="board-wrap"><div class="board" id="board"></div></div>
        <div class="tide-bar" id="tideBar" role="status" aria-live="polite"></div>
        <div class="palette" id="palette" role="group" aria-label="Choose a colour"></div>
        <div class="game-actions">
          <button class="btn btn-ghost" data-act="howto">How to play</button>
          ${this.driver.mode === 'solo' ? '<button class="btn btn-ghost" data-act="restart">Restart</button>' : ''}
        </div>
      </section>`;

    content.querySelector('[data-act="menu"]')?.addEventListener('click', () => toMenu());
    content.querySelector('[data-act="mute"]')?.addEventListener('click', () => {
      toggleMute();
      this.updateMuteBtn();
    });
    content.querySelector('[data-act="howto"]')?.addEventListener('click', () =>
      openModal('How to play', HOWTO_HTML),
    );
    content
      .querySelector('[data-act="restart"]')
      ?.addEventListener('click', () => this.driver.restart?.());
    document.getElementById('palette')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.swatch');
      if (btn && !btn.disabled) this.pick(Number(btn.dataset.color));
    });
    this.updateMuteBtn();
  }

  private updateMuteBtn() {
    const b = document.getElementById('muteBtn');
    if (b) b.textContent = sfx.muted() ? '🔇' : '🔊';
  }

  /** Gate input without hiding the board — see the countdown in enterMpGame(). */
  setLocked(on: boolean) {
    this.locked = on;
    this.refresh(this.driver.getState());
  }

  private pick(color: number) {
    if (this.locked || !this.driver.isMyTurn()) return;
    sfx.play('select');
    this.driver.play(color);
  }

  private handleKey(e: KeyboardEvent) {
    if (e.key >= '1' && e.key <= '9') {
      // Not a fixed 1-6: Wilds paints in seven, and a hard-coded range would
      // silently make the last swatch keyboard-only-unreachable.
      const c = Number(e.key) - 1;
      if (c < this.driver.getState().colors) this.pick(c);
    } else if (e.key.toLowerCase() === 'r' && this.driver.mode === 'solo') {
      this.driver.restart?.();
    } else if (e.key.toLowerCase() === 'm') {
      toggleMute();
      this.updateMuteBtn();
    }
  }

  /** Reset the breakdown for a fresh board (solo restart, or a new MP round). */
  private resetStats(state: GameState) {
    this.stats = Array.from({ length: state.players }, () => ({ moves: 0, taken: 0, best: 0 }));
    this.countedTurn = state.turnNo;
  }

  private track(state: GameState, mover: number, absorbed: number) {
    if (mover < 0 || state.turnNo <= this.countedTurn) return;
    this.countedTurn = state.turnNo;
    const st = this.stats[mover];
    if (!st) return;
    st.moves += 1;
    st.taken += absorbed;
    st.best = Math.max(st.best, absorbed);
  }

  private update(state: GameState, meta: { absorbed: number[]; mover: number }) {
    if (meta.mover < 0 && state.turnNo === 0) this.resetStats(state);
    this.track(state, meta.mover, meta.absorbed.length);
    if (meta.absorbed.length && meta.mover >= 0) {
      const colorIdx = state.color[meta.mover];
      this.board.paint(state, meta.absorbed);
      this.board.burst(meta.absorbed, colorIdx, meta.absorbed.length);
      const pitch = 1 + Math.min(0.8, meta.absorbed.length * 0.05);
      sfx.play('bloom', pitch);
      if (meta.absorbed.length >= 6) sfx.play('powerup');
    } else {
      this.board.paint(state);
    }
    this.refresh(state);
    if (state.finished && !this.resultsShown) {
      this.resultsShown = true;
      setTimeout(() => this.showResults(state), 480);
    } else if (this.driver.isMyTurn() && meta.mover >= 0 && meta.mover !== this.driver.myPlayer()) {
      sfx.play('turn');
    }
  }

  private refresh(state: GameState) {
    const names = this.driver.names();
    const sc = scores(state);
    const me = this.driver.myPlayer();

    const hud = document.getElementById('hud');
    if (hud) {
      hud.innerHTML = state.tile
        ? Array.from({ length: state.players }, (_, p) => {
            const active = !state.finished && state.turn === p;
            return `<div class="chip ${active ? 'active' : ''} ${p === me ? 'me' : ''}"
              style="--accent:${PLAYER_ACCENTS[p]};--dot:${TILE_COLORS[state.color[p]]}">
              <span class="chip-dot"></span>
              <span class="chip-name">${escapeHtml(names[p] ?? `P${p + 1}`)}${p === me ? ' (you)' : ''}</span>
              <span class="chip-score">${sc[p]}</span>
            </div>`;
          }).join('')
        : '';
    }

    // The tide governs what the palette can do, so it lives right above it. Dots
    // rather than a number: the shape of the row reads at a glance, and the whole
    // point is that it grows.
    const tideBar = document.getElementById('tideBar');
    if (tideBar && !state.finished) {
      const reach = bloomReach(state);
      const next = TIDE_EVERY(state.players) - (state.turnNo % TIDE_EVERY(state.players));
      const rose = reach > this.lastReach;
      tideBar.className = `tide-bar${rose && this.lastReach >= 0 ? ' rose' : ''}`;
      tideBar.innerHTML =
        `<span class="tide-label">Bloom reach</span>` +
        `<span class="tide-dots" aria-hidden="true">${'<i></i>'.repeat(Math.min(reach, 8))}</span>` +
        `<span class="tide-n">${reach}</span>` +
        `<span class="tide-next">tide rises in ${next} move${next === 1 ? '' : 's'}</span>`;
      tideBar.setAttribute(
        'aria-label',
        `Bloom reach ${reach} tile${reach === 1 ? '' : 's'}. Tide rises in ${next} move${next === 1 ? '' : 's'}.`,
      );
      // Pitched below the big-bloom powerup so the two don't read as the same event.
      if (rose && this.lastReach >= 0) sfx.play('powerup', 0.7);
      this.lastReach = reach;
    } else if (tideBar) {
      tideBar.innerHTML = '';
    }

    const banner = document.getElementById('turnBanner');
    if (banner) {
      if (state.finished) banner.textContent = 'Game over';
      else if (me < 0) banner.textContent = `Spectating — ${escapeHtml(names[state.turn] ?? '')}'s move`;
      else if (state.turn === me) banner.textContent = 'Your move — pick a colour';
      else
        banner.innerHTML = `<span class="spinner sm" aria-hidden="true"></span> ${escapeHtml(names[state.turn] ?? 'Rival')} is blooming…`;
    }

    this.renderPalette(state);
  }

  private renderPalette(state: GameState) {
    const pal = document.getElementById('palette');
    if (!pal) return;
    const me = this.driver.myPlayer();
    const myTurn = this.driver.isMyTurn() && !this.locked;
    const myColor = me >= 0 ? state.color[me] : -1;
    let html = '';
    for (let c = 0; c < state.colors; c++) {
      const isCurrent = c === myColor;
      const gain = myTurn && !isCurrent ? captureCount(state, me, c) : -1;
      const disabled = !myTurn || isCurrent;
      html += `<button class="swatch ${isCurrent ? 'is-current' : ''}" data-color="${c}"
        style="--c:${TILE_COLORS[c]}" ${disabled ? 'disabled' : ''}
        aria-label="Colour ${c + 1}${gain >= 0 ? `, gains ${gain} tiles` : ''}${isCurrent ? ', your current colour' : ''}">
        ${isCurrent ? '<span class="sw-lock">✓</span>' : gain > 0 ? `<span class="sw-badge">+${gain}</span>` : ''}
      </button>`;
    }
    pal.innerHTML = html;
  }

  private showResults(state: GameState) {
    const names = this.driver.names();
    const sc = scores(state);
    const win = winners(state);
    const me = this.driver.myPlayer();
    const ranked = Array.from({ length: state.players }, (_, p) => p).sort((a, b) => sc[b] - sc[a]);
    // Share of the tiles actually WON, not of the whole board: a game can end with
    // neutral tiles still on it (a stalled board), and "31/81" then implies 81 was
    // reachable and everyone underperformed. The claimed total is what was fought
    // over, so the fractions sum to 1 and the winner's lead reads honestly.
    const claimed = sc.reduce((a, b) => a + b, 0);
    const neutral = state.tile.length - claimed;

    let headline: string;
    if (win.length > 1) headline = win.includes(me) ? "It's a tie!" : `Tie — ${names[win[0]]} & ${names[win[1]]}`;
    else if (win[0] === me) headline = 'You win! 🎉';
    else headline = `${escapeHtml(names[win[0]] ?? 'Rival')} wins`;

    if (this.driver.mode === 'solo') {
      const myScore = sc[0];
      const best = Math.max(...sc.filter((_, i) => i !== 0));
      const margin = myScore - best;
      const rec = store.get('record', { wins: 0, games: 0, bestMargin: 0 });
      rec.games += 1;
      if (win.length === 1 && win[0] === 0) {
        rec.wins += 1;
        rec.bestMargin = Math.max(rec.bestMargin, margin);
      }
      store.set('record', rec);
    }

    sfx.play(win.includes(me) || me < 0 ? 'win' : 'lose');

    const stat = (p: number): PlayerStats => this.stats[p] ?? { moves: 0, taken: 0, best: 0 };
    const biggest = Math.max(0, ...ranked.map((p) => stat(p).best));

    const overlay = document.createElement('div');
    overlay.className = 'results-overlay';
    overlay.innerHTML = `
      <div class="results" role="dialog" aria-modal="true" aria-label="Results">
        <h2 class="results-title">${headline}</h2>
        <ul class="results-list">
          ${ranked
            .map((p, i) => {
              const st = stat(p);
              const share = claimed > 0 ? Math.round((sc[p] / claimed) * 100) : 0;
              return `<li class="result-row ${p === me ? 'me' : ''}">
                <span class="result-rank">${i + 1}</span>
                <span class="result-dot" style="background:${TILE_COLORS[state.color[p]]};border-color:${PLAYER_ACCENTS[p]}"></span>
                <span class="result-main">
                  <span class="result-name">${escapeHtml(names[p] ?? `P${p + 1}`)}${p === me ? ' (you)' : ''}</span>
                  <span class="result-detail">
                    +${st.taken} taken · best bloom +${st.best}${st.best === biggest && st.best > 0 ? ' 🏅' : ''} · ${st.moves} move${st.moves === 1 ? '' : 's'}
                  </span>
                </span>
                <span class="result-score">${sc[p]}<small>/${claimed} · ${share}%</small></span>
              </li>`;
            })
            .join('')}
        </ul>
        <p class="results-note">${
          neutral > 0
            ? `${neutral} tile${neutral === 1 ? '' : 's'} left unclaimed — nobody could reach ${neutral === 1 ? 'it' : 'them'}.`
            : 'Every tile on the board was claimed.'
        }</p>
        <div class="results-actions">
          <button class="btn btn-primary" data-act="again">Play again</button>
          ${this.driver.mode === 'mp' ? '<button class="btn" data-act="start-now" hidden>Start now</button>' : ''}
          ${this.driver.mode === 'mp' ? '<button class="btn" data-act="lobby">Back to lobby</button>' : ''}
          <button class="btn" data-act="share">Share</button>
          <button class="btn btn-ghost" data-act="menu">Menu</button>
        </div>
        ${this.driver.mode === 'mp' ? '<p class="again-status" role="status" aria-live="polite"></p>' : ''}
      </div>`;
    content.querySelector('.game')?.appendChild(overlay);

    const againBtn = overlay.querySelector<HTMLButtonElement>('[data-act="again"]')!;
    const status = overlay.querySelector<HTMLElement>('.again-status');

    // The round is over: reopen voting so "Play again" has something to vote for.
    if (this.driver.mode === 'mp') rounds?.finish();

    const paintAgain = () => {
      if (!rounds) return;
      const s = rounds.state();
      againBtn.textContent = s.voted ? 'Ready — waiting…' : 'Play again';
      againBtn.classList.toggle('waiting', s.voted);

      // The host never has to sit and hope: once enough people are in, it can
      // start immediately rather than wait out the countdown.
      const startNow = overlay.querySelector<HTMLButtonElement>('[data-act="start-now"]');
      if (startNow) startNow.hidden = !s.canStart || s.votes.length === s.present.length;

      if (!status) return;
      const waiting = s.present.length - s.votes.length;
      const secs = s.startsInMs !== null ? Math.ceil(s.startsInMs / 1000) : null;
      if (!s.voted) {
        status.textContent = `${s.votes.length}/${s.present.length} ready for another round`;
      } else if (secs !== null) {
        // Say WHY we are still waiting and when it ends. A bare "waiting…" with
        // no horizon is what made this feel like a hang.
        status.textContent = `Starting in ${secs}s — waiting for ${waiting} more player${
          waiting === 1 ? '' : 's'
        }`;
      } else if (waiting > 0) {
        status.textContent = `Waiting for ${waiting} more player${waiting === 1 ? '' : 's'}…`;
      } else {
        status.textContent = 'Starting…';
      }
    };

    againBtn.addEventListener('click', () => {
      if (this.driver.mode === 'solo') {
        overlay.remove();
        this.resultsShown = false;
        this.driver.restart?.();
        return;
      }
      // NOT a rejoin. The room and the whole peer mesh stay exactly as they are;
      // this only registers a vote, and the next round starts underneath us once
      // everyone has voted. Leaving and rejoining here is what stranded both
      // players alone as host — see engine/net.ts.
      if (!rounds) return;
      if (rounds.state().voted) rounds.unvote();
      else rounds.vote();
      paintAgain();
    });

    if (this.driver.mode === 'mp') {
      paintAgain();
      this.againTick = setInterval(() => {
        if (!document.body.contains(againBtn)) {
          if (this.againTick) clearInterval(this.againTick);
          this.againTick = null;
          return;
        }
        paintAgain();
      }, 500);
    }

    overlay.querySelector('[data-act="start-now"]')?.addEventListener('click', () => rounds?.go());
    overlay.querySelector('[data-act="lobby"]')?.addEventListener('click', () => {
      // Back to the lobby WITHOUT leaving the room — the mesh and the roster both
      // survive. From there you can wait, re-ready, or see who is still around,
      // instead of the summary being a dead end with only Menu.
      rounds?.unvote();
      backToLobby();
    });
    overlay.querySelector('[data-act="menu"]')?.addEventListener('click', () => toMenu());
    overlay.querySelector('[data-act="share"]')?.addEventListener('click', () => {
      void shareResult(sc[me >= 0 ? me : 0], claimed);
    });
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey);
    if (this.againTick) clearInterval(this.againTick);
    this.againTick = null;
    this.board.destroy();
    this.driver.destroy();
  }
}

async function shareResult(myScore: number, claimed: number): Promise<void> {
  const text = `I claimed ${myScore}/${claimed} tiles in Hexbloom 🐝`;
  const url = 'https://hexbloom.benrichardson.dev';
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Hexbloom', text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text} ${url}`);
    flashToast('Result copied');
  } catch {
    flashToast(`${text} ${url}`);
  }
}

function flashToast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2000);
}

function toggleMute(): void {
  settings.muted = !settings.muted;
  sfx.setMuted(settings.muted);
  store.set('muted', settings.muted);
  if (!settings.muted) sfx.play('blip');
}

// ---------------------------------------------------------------------------
// Screen router.
// ---------------------------------------------------------------------------

function cleanupSession(): void {
  session?.destroy();
  session = null;
}

/**
 * Tear the room down for good. Only ever called on the way to the menu — NEVER
 * between rounds. `net.leave()` is awaited because Trystero keeps the room in its
 * cache until teardown finishes; joining again before then hands back the dying
 * room and every peer ends up alone and self-elected as host. A rematch keeps the
 * Net alive and starts a new round inside it (engine/rematch.ts).
 */
function leaveRoom(): Promise<void> {
  lobbyView?.destroy();
  lobbyView = null;
  roomEntry?.destroy();
  roomEntry = null;
  rounds?.destroy();
  rounds = null;
  activeNetGame?.destroy();
  activeNetGame = null;
  // Off the list and off the board, before anything else can go wrong. Leaving is
  // one of the three ways a room stops being public (the others are going private
  // and starting a round) and it is the one where nobody is left to notice a
  // stale listing.
  listing?.close();
  listing = null;
  if (listingTick) clearInterval(listingTick);
  listingTick = undefined;
  roomPublic = false;
  roomCode = '';
  // Also covers a board opened by the browse screen: leaveRoom() is on every path
  // out of it.
  boardAccess.close();
  countdown?.cancel();
  countdown = null;
  // The room is over for us — take it out of the URL so a refresh, or reopening
  // from the home screen, lands on the menu instead of silently rejoining.
  clearRoomInUrl();
  const leaving = net;
  net = null;
  // CHAIN, never replace. leaveRoom() runs again on the way into a new room, and
  // by then `net` is already null — replacing the promise there would hand back an
  // instantly-resolved teardown while the real one was still inside Trystero's
  // 99ms window, and the next createNet would throw.
  roomTeardown = roomTeardown.then(() => leaving?.leave()).then(
    () => undefined,
    () => undefined,
  );
  return roomTeardown;
}

function toMenu(): void {
  cleanupSession();
  void leaveRoom(); // also drops ?room= — see clearRoomInUrl in engine/lobby.ts
  renderMenu();
}

function renderMenu(): void {
  content.innerHTML = menuHTML(store.get('record', { wins: 0, games: 0, bestMargin: 0 }));
  const setToggle = (act: string, on: boolean, onLabel: string, offLabel: string) => {
    const b = content.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
    if (!b) return;
    b.textContent = on ? onLabel : offLabel;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
  };
  setToggle('mute', !settings.muted, '🔊 Sound on', '🔇 Sound off');
  setToggle('symbols', settings.symbols, '◆ Symbols on', '◇ Symbols off');

  content.querySelector('[data-act="solo"]')?.addEventListener('click', renderSoloSetup);
  content.querySelector('[data-act="friends"]')?.addEventListener('click', enterFriends);
  content
    .querySelector('[data-act="howto"]')
    ?.addEventListener('click', () => openModal('How to play', HOWTO_HTML));
  content
    .querySelector('[data-act="about"]')
    ?.addEventListener('click', () => openModal('About Hexbloom', ABOUT_HTML));
  content.querySelector('[data-act="mute"]')?.addEventListener('click', () => {
    toggleMute();
    setToggle('mute', !settings.muted, '🔊 Sound on', '🔇 Sound off');
  });
  content.querySelector('[data-act="symbols"]')?.addEventListener('click', () => {
    settings.symbols = !settings.symbols;
    store.set('symbols', settings.symbols);
    setToggle('symbols', settings.symbols, '◆ Symbols on', '◇ Symbols off');
  });
}

function renderSoloSetup(): void {
  const defaults = store.get('solo', { rivals: 1, difficulty: 'normal' as Difficulty });
  content.innerHTML = soloSetupHTML(defaults);
  let rivals = defaults.rivals;
  let difficulty = defaults.difficulty;

  // The board picker is the same control as the lobby's, and writes the same
  // stored pick — so the mode you play solo is the one you'd host with.
  const mount = content.querySelector<HTMLElement>('#soloModes');
  const paintModes = () => {
    if (!mount) return;
    mount.innerHTML = modePicker();
    wireModePicker(paintModes);
  };
  paintModes();

  content.querySelector('[data-act="back"]')?.addEventListener('click', renderMenu);
  content.querySelectorAll<HTMLButtonElement>('[data-rivals]').forEach((b) =>
    b.addEventListener('click', () => {
      rivals = Number(b.dataset.rivals);
      content.querySelectorAll('[data-rivals]').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    }),
  );
  content.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((b) =>
    b.addEventListener('click', () => {
      difficulty = b.dataset.diff as Difficulty;
      content.querySelectorAll('[data-diff]').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    }),
  );
  content.querySelector('[data-act="start"]')?.addEventListener('click', () => {
    store.set('solo', { rivals, difficulty });
    cleanupSession();
    session = new GameSession(new SoloDriver({ rivals, difficulty, mode: modeOf(modeId) }));
  });
}

function enterFriends(): void {
  void leaveRoom();

  // Deep-linked via an invite? Join it straight away, once — we are the guest
  // here, never the host: whoever sent the link already holds the room. Read at
  // boot, because leaveRoom() strips ?room= from the URL on the way past.
  if (pendingRoom) {
    const code = pendingRoom;
    pendingRoom = null;
    void openRoom(code, false, false);
    return;
  }

  // Otherwise show the create/join screen so a friend can type the code, not
  // just tap the link.

  content.innerHTML = `
    <section class="screen lobby-screen">
      <button class="back" data-act="back" aria-label="Back to menu">‹ Menu</button>
      <div class="lobby-mount" id="entryMount"></div>
    </section>`;
  content.querySelector('[data-act="back"]')?.addEventListener('click', toMenu);

  // Handing the entry `board` is what makes public rooms exist at all — it does
  // not join anything until the player taps Browse.
  roomEntry = createRoomEntry({
    container: document.getElementById('entryMount')!,
    subtitle: 'Start a new room, or enter a friend’s code to join theirs.',
    board: boardAccess,
    onSubmit: (code, created, isPublic) => void openRoom(code, created, isPublic),
  });
}

/**
 * Join a room ONCE and hold it for as long as the player stays. Every round — the
 * first and every rematch — runs inside this one Net via `rounds`. Nothing here
 * may call net.leave() except the trip back to the menu.
 */
async function openRoom(code: string, created: boolean, isPublic: boolean): Promise<void> {
  leaveRoom();
  // A previous room may still be tearing down (Trystero defers it ~99ms). Joining
  // inside that window returns the dying room, so wait it out.
  await roomTeardown;
  // Never open the game room STUN-only. Already resolved unless this is the very
  // first mesh of the session, and it fails open, so it costs nothing.
  await turnReady;
  // The public flag stays OUT of the URL. It is the host's live choice, not a
  // property of the code: baked into an invite link it would survive the host
  // flipping the room private, and every guest who forwarded the link would be
  // handing on a claim that is no longer true.
  setRoomInUrl(code);
  roomCode = code;
  roomPublic = created && isPublic;

  try {
    net = createNet(
      // `created` is the difference between minting this code and walking into
      // someone else's room. Only the minter may host on arrival; a guest waits
      // to hear from the incumbent instead of racing it for the role.
      { appId: ROOM_APP_ID, roomId: code, claimHost: created },
      {
        onPeers: () => activeNetGame?.onRoster(),
        // The round's authority is the room's host narrowed to the roster, so a
        // handover in the room is a handover in the match — re-check it here too,
        // not only when the roster moves.
        onHostChange: () => activeNetGame?.onRoster(),
      },
    );
  } catch (err) {
    // The room is somehow still held (see engine/net.ts). Never strand the player
    // on a blank screen — say so and go back somewhere they can act.
    console.error(err);
    flashToast('Could not open that room — try again');
    toMenu();
    return;
  }

  rounds = createRounds({
    net,
    playerName: playerName(),
    minPlayers: MIN_PLAYERS,
    // Only the host's pick counts, and it travels frozen with the start — a mode
    // each peer read from its own UI is a mode two peers can disagree about.
    // `pub` rides along so a guest can see that strangers may walk in; it is
    // gossiped with presence, so it is live rather than a claim from join time.
    roundOpts: () => ({ mode: modeId, pub: roomPublic }),
    onRound: ({ seed, players, opts }) => enterMpGame(seed, players, opts),
  });

  listing = createListing(boardAccess);
  // Player counts move, the host can flip the room private, and the host role
  // itself can transfer mid-lobby. Poll one rule rather than hunt every edge.
  listingTick = setInterval(syncListing, 1000);

  showLobby();
}

function showLobby(): void {
  if (!net || !rounds) return;
  lobbyView?.destroy();
  content.innerHTML = `
    <section class="screen lobby-screen">
      <button class="back" data-act="back" aria-label="Back to menu">‹ Menu</button>
      <div class="lobby-mount" id="lobbyMount"></div>
    </section>`;
  content.querySelector('[data-act="back"]')?.addEventListener('click', toMenu);

  lobbyView = createLobby({
    container: document.getElementById('lobbyMount')!,
    net,
    rounds,
    roomCode,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    // Only the host chooses; everyone else sees what they are about to play, so
    // nobody is surprised by a 13×11 board they did not pick.
    modeSlot: () => (net!.isHost() ? modePicker() + visibilityPicker() : modeNote()),
    onModeMount: () => {
      wireModePicker(() => lobbyView?.repaint());
      wireVisibility(() => lobbyView?.repaint());
    },
  });
  syncListing();
}

/**
 * Leave the finished round's screen for the lobby while STAYING in the room. The
 * round is over, so its NetGame goes — leaving it attached would have a dead
 * board answering the next round's moves (see net-game.ts destroy()) — but the
 * Net and `rounds` live on, exactly as they do between rematches.
 */
function backToLobby(): void {
  cleanupSession();
  activeNetGame = null;
  showLobby();
}

function enterMpGame(seed: number, players: RoundPlayer[], opts: unknown): void {
  if (!net) return;
  lobbyView?.destroy();
  lobbyView = null;
  // The round is starting, so the room comes off the list right now — not up to a
  // tick later, and not "once someone notices". syncListing reads `lobbyView`,
  // which is the null above.
  syncListing();
  countdown?.cancel();
  countdown = null;

  // The roster arrives frozen from the host — identical bytes on every peer — so
  // seat N is the same player everywhere. Each peer deriving it locally is how
  // scores used to land on the wrong name.
  const seats = players.map((p) => p.id);
  if (!seats.includes(net.selfId)) {
    // Not in this round's roster (we walked in mid-start). Wait for the next round
    // rather than silently playing as player 0.
    cleanupSession();
    showLobby();
    flashToast('Next round — you’re in the lobby');
    return;
  }

  cleanupSession();
  activeNetGame = null;

  // Roster AND mode arrive frozen from the host, identical bytes on every peer, so
  // seat N is the same player and everyone builds the same honeycomb. Deriving
  // either locally is how peers end up in different games.
  const m = modeOf((opts as { mode?: unknown } | undefined)?.mode);

  const driver = new MpDriver(players.map((p) => p.name));
  activeNetGame = new NetGame({
    net,
    seed,
    seats,
    board: { w: m.w, h: m.h, colors: m.colors },
    onUpdate: (s, m2) => driver.forward(s, m2),
  });
  driver.attach(activeNetGame);
  session = new GameSession(driver);

  // The board is up and readable behind the count, but the palette is not live
  // yet: everyone gets the same look at the honeycomb before anyone can take a
  // tile off it. Each peer counts locally from the host's start arriving.
  const cdHost = document.createElement('div');
  cdHost.className = 'cd-host';
  content.querySelector('.game')?.appendChild(cdHost);
  session.setLocked(true);
  countdown = createCountdown({
    root: cdHost,
    sfx,
    reducedMotion,
    onDone: () => {
      countdown = null;
      cdHost.remove();
      session?.setLocked(false);
    },
  });
}

// First visit: auto-show how to play.
renderMenu();
if (!store.get('seenHowto', false)) {
  store.set('seenHowto', true);
  openModal('How to play', HOWTO_HTML);
}
