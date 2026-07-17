/**
 * main.ts — Hexbloom bootstrap and orchestration. Owns the screen router, the
 * solo (vs-AI) and multiplayer (P2P) drivers, and the in-game session that turns
 * state updates into board paint + particles + sound. Heavy rules live in
 * game.ts; netcode in net-game.ts; rendering in render.ts.
 */

import './styles/main.css';
import {
  applyMove,
  captureCount,
  chooseAiColor,
  generateBoard,
  scores,
  winners,
  type Difficulty,
  type GameState,
} from './game';
import { newSeed } from './engine/rng';
import { createSfx } from './engine/sound';
import { createStore } from './engine/storage';
import { createNet, type Net } from './engine/net';
import { createRounds, type RoundPlayer, type Rounds } from './engine/rematch';
import { createLobby, createRoomEntry, normalizeRoomCode, setRoomInUrl } from './engine/lobby';
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
const RIVAL_NAMES = ['Vero', 'Cyra', 'Juno'];
const NAME_POOL = ['Fox', 'Wren', 'Sage', 'Koi', 'Lark', 'Bea', 'Nova', 'Pip', 'Ozzy', 'Rio'];

const store = createStore(APP_ID);
const settings = {
  muted: store.get('muted', false),
  symbols: store.get('symbols', false),
};
const sfx = createSfx(settings.muted);

const app = document.getElementById('app')!;
app.innerHTML = `<main class="main-content" id="content"></main>${FOOTER_HTML}`;
const content = document.getElementById('content')!;

let net: Net | null = null;
let rounds: Rounds | null = null;
let lobbyView: { destroy: () => void } | null = null;
let roomEntry: { destroy: () => void } | null = null;
let activeNetGame: NetGame | null = null;
let session: GameSession | null = null;
let roomCode = '';

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

  constructor(private opts: { rivals: number; difficulty: Difficulty }) {
    const players = opts.rivals + 1;
    this.state = generateBoard(newSeed(), { players });
    this._names = ['You', ...RIVAL_NAMES.slice(0, opts.rivals)];
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
    this.state = generateBoard(newSeed(), { players: this.opts.rivals + 1 });
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

  private pick(color: number) {
    if (!this.driver.isMyTurn()) return;
    sfx.play('select');
    this.driver.play(color);
  }

  private handleKey(e: KeyboardEvent) {
    if (e.key >= '1' && e.key <= '6') {
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
    const myTurn = this.driver.isMyTurn();
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
      if (!status) return;
      const waiting = s.present.length - s.votes.length;
      status.textContent = s.voted
        ? waiting > 0
          ? `Waiting for ${waiting} more player${waiting === 1 ? '' : 's'}…`
          : 'Starting…'
        : `${s.votes.length}/${s.present.length} ready for another round`;
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
  roomCode = '';
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

/** Drop a stale ?room= so a fresh solo/menu session doesn't carry it. */
function stripRoomParam(): void {
  const url = new URL(location.href);
  if (url.searchParams.has('room')) {
    url.searchParams.delete('room');
    history.replaceState(null, '', url.toString());
  }
}

function toMenu(): void {
  cleanupSession();
  void leaveRoom();
  stripRoomParam();
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
    session = new GameSession(new SoloDriver({ rivals, difficulty }));
  });
}

function enterFriends(): void {
  void leaveRoom();

  // Deep-linked via an invite (?room=)? Join it straight away. Otherwise show
  // the create/join screen so a friend can type the code, not just tap the link.
  const deep = normalizeRoomCode(new URL(location.href).searchParams.get('room') ?? '');
  if (deep.length >= 3) {
    void openRoom(deep);
    return;
  }

  content.innerHTML = `
    <section class="screen lobby-screen">
      <button class="back" data-act="back" aria-label="Back to menu">‹ Menu</button>
      <div class="lobby-mount" id="entryMount"></div>
    </section>`;
  content.querySelector('[data-act="back"]')?.addEventListener('click', toMenu);

  roomEntry = createRoomEntry({
    container: document.getElementById('entryMount')!,
    subtitle: 'Start a new room, or enter a friend’s code to join theirs.',
    onSubmit: (code) => void openRoom(code),
  });
}

/**
 * Join a room ONCE and hold it for as long as the player stays. Every round — the
 * first and every rematch — runs inside this one Net via `rounds`. Nothing here
 * may call net.leave() except the trip back to the menu.
 */
async function openRoom(code: string): Promise<void> {
  leaveRoom();
  // A previous room may still be tearing down (Trystero defers it ~99ms). Joining
  // inside that window returns the dying room, so wait it out.
  await roomTeardown;
  setRoomInUrl(code);
  roomCode = code;

  try {
    net = createNet(
      { appId: APP_ID, roomId: code },
      { onPeers: () => activeNetGame?.onRoster() },
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
    minPlayers: 2,
    onRound: ({ seed, players }) => enterMpGame(seed, players),
  });

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
    minPlayers: 2,
    maxPlayers: 4,
  });
}

function enterMpGame(seed: number, players: RoundPlayer[]): void {
  if (!net) return;
  lobbyView?.destroy();
  lobbyView = null;

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
  const driver = new MpDriver(players.map((p) => p.name));
  activeNetGame = new NetGame({
    net,
    seed,
    seats,
    onUpdate: (s, m) => driver.forward(s, m),
  });
  driver.attach(activeNetGame);
  session = new GameSession(driver);
}

// First visit: auto-show how to play.
renderMenu();
if (!store.get('seenHowto', false)) {
  store.set('seenHowto', true);
  openModal('How to play', HOWTO_HTML);
}
