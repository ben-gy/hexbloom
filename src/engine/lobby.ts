// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * lobby.ts — a drop-in peer-to-peer lobby built on the engine's net + rematch.
 * Style .lobby-* / .spinner in the game CSS.
 *
 * WHY THIS IS NOT '@ben-gy/game-engine/lobby'. This is a superset of the engine
 * view, carrying Hexbloom's public-rooms surface — the private/public chooser,
 * the noticeboard browser, the IP-disclosure notes, BoardAccess/Listing and the
 * roomAd() rule that decides whether a room is advertised — plus the host-only
 * mode picker slot. None of that has a seam in the engine's lobby, so it stays
 * here. It is a VIEW only: every behaviour that matters for connecting is
 * imported from the package below, so the v1.1.0 netcode fixes apply in full.
 *
 * This file is a VIEW. It owns no protocol: presence, readiness, quorum, the
 * shared seed and the frozen roster all come from rematch.ts, so starting the
 * first round and starting a rematch are the same code path. The lobby used to
 * run its own 'pres'/'preq'/'go' channels, which meant two ways to start a game
 * and a 'go' that carried a seed but no roster — leaving peers free to disagree
 * about who player 0 was.
 */

import type { Net, PeerId } from '@ben-gy/game-engine/net';
// Types only. Importing the noticeboard's implementation here would drag a mesh
// of strangers into every screen that shows a room code — see BoardAccess.
import type { PublicRoom, RoomAd } from '@ben-gy/game-engine/noticeboard';
import type { Rounds } from '@ben-gy/game-engine/rematch';

export interface LobbyPlayer {
  id: PeerId;
  name: string;
  ready: boolean;
  isHost: boolean;
  isSelf: boolean;
}

export interface LobbyConfig {
  container: HTMLElement;
  net: Net;
  /** The round protocol driving this room. Owns start; the lobby just renders. */
  rounds: Rounds;
  roomCode: string;
  minPlayers?: number;
  maxPlayers?: number;
  onCancel?: () => void;
  /** Optional game-settings block rendered above the actions (host picks). */
  modeSlot?: () => string;
  /** Called after each repaint so the slot's controls can be re-wired. */
  onModeMount?: () => void;
}

/** Read ?room= from the URL, or mint a fresh 4-char code and push it into the URL. */
export function getOrCreateRoomCode(): string {
  const url = new URL(location.href);
  const existing = url.searchParams.get('room');
  if (existing) return normalizeRoomCode(existing);
  const code = mintCode();
  url.searchParams.set('room', code);
  history.replaceState(null, '', url.toString());
  return code;
}

export function mintCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/O/0/1/L ambiguity
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** Canonicalise a hand-typed / linked code so peers agree on the room id. */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/** Push a chosen room code into the URL so the invite link + a refresh both work. */
export function setRoomInUrl(roomCode: string): void {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  url.hash = '';
  history.replaceState(null, '', url.toString());
}

/**
 * Drop ?room= on the way out of a room. Without this the code outlives the
 * session: reopen the page — from history, or a home-screen icon — and the stale
 * parameter drags you straight back into a room you have left, with no way to
 * start a fresh one. "It always spawns the same game room no matter what."
 */
export function clearRoomInUrl(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has('room')) return;
  url.searchParams.delete('room');
  url.hash = '';
  history.replaceState(null, '', url.toString());
}

export function inviteLink(roomCode: string): string {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  url.hash = '';
  return url.toString();
}

// ---- public rooms -----------------------------------------------------------
//
// Everything below exists to keep ONE promise: a private room is invisible, and
// a player who only plays with friends never touches the noticeboard at all.
// The board is WebRTC, so being on it — listing OR browsing — hands your IP to
// every stranger who is also on it. That is the cost, it is unavoidable in a
// serverless lobby, and the only honest answer is to make it opt-in on both
// sides and say so where the player opts in rather than in About.

/** Shown under the public/private choice. Plain language, no euphemism. */
export const P2P_IP_NOTE =
  'Public games are peer-to-peer, so other players can see your IP address — the ' +
  'same as any P2P game, but with strangers rather than friends.';

/** Shown under the browse button. Browsing costs the same thing, so it says so. */
export const BROWSE_IP_NOTE =
  'The list is peer-to-peer too: while it is open, the other people browsing can ' +
  'see your IP address. It closes as soon as you leave this screen.';

/**
 * The noticeboard, as the room screens are allowed to see it.
 *
 * Deliberately NOT a Noticeboard. The board gets opened and closed repeatedly
 * over a session (browse → back → browse; public → private → public) and net.ts
 * throws if its room is rejoined while the last one is still tearing down. The
 * owner serialises that; the views just declare what they want.
 */
export interface BoardAccess {
  /** Join the board and start listing. Only ever from an explicit opt-in. */
  open(onRooms: (rooms: PublicRoom[]) => void): Promise<void>;
  /** Advertise this room, joining the board if we are not on it yet. */
  announce(ad: RoomAd): Promise<void>;
  /** Leave the board. Never hold the mesh open behind a screen nobody is on. */
  close(): void;
}

export interface ListingState {
  /** The host's choice. Private is the default, and private NEVER announces. */
  isPublic: boolean;
  isHost: boolean;
  /** False the moment the lobby is gone — a started round leaves the board. */
  inLobby: boolean;
  playing: boolean;
  code: string;
  host: string;
  players: number;
  max: number;
  note?: string;
}

/**
 * The single rule for "is this room on the public list?", returning the ad to
 * broadcast or null meaning get off the board.
 *
 * One function, so the announce tick, the round start and the way out cannot
 * answer it differently. A room still advertising after it went private is not
 * a cosmetic bug — it is the one promise this feature makes, broken.
 */
export function roomAd(s: ListingState): RoomAd | null {
  if (!s.isPublic || !s.isHost || !s.inLobby || s.playing) return null;
  return {
    code: s.code,
    host: s.host,
    players: s.players,
    max: s.max,
    playing: false,
    ...(s.note ? { note: s.note } : {}),
  };
}

export interface Listing {
  /** Feed it the room's current truth; it does the rest. Cheap to call often. */
  sync(s: ListingState): void;
  close(): void;
}

/** Keeps the board's copy of this room in step with reality, and lets go of the
 *  board the instant the room stops qualifying. */
export function createListing(board: BoardAccess): Listing {
  let last = '';
  return {
    sync(s: ListingState) {
      const ad = roomAd(s);
      // Re-announcing an unchanged ad every tick would be pure noise: the board
      // already re-broadcasts what it holds every 2s to prove the room is alive.
      const key = ad ? JSON.stringify(ad) : '';
      if (key === last) return;
      last = key;
      if (!ad) {
        board.close();
        return;
      }
      void board.announce(ad);
    },
    close() {
      last = '';
      board.close();
    },
  };
}

export interface RoomEntryConfig {
  container: HTMLElement;
  /**
   * `created` is true for a fresh hosted room, false when a code was typed in or
   * picked off the public list. `isPublic` is only ever true alongside `created`
   * — you cannot list someone else's room.
   */
  onSubmit: (roomCode: string, created: boolean, isPublic: boolean) => void;
  onCancel?: () => void;
  title?: string;
  subtitle?: string;
  /** Omit and this game has no public rooms at all: no toggle, no browse. */
  board?: BoardAccess;
  /**
   * How long to keep saying "joining" before believing an empty list. Being ON
   * the board is not the same as being connected to anyone on it — see browse().
   */
  settleMs?: number;
}

/**
 * "Create or join a room" screen shown before the lobby, so a friend can TYPE
 * the code instead of needing the invite link. Skip it when ?room= is present.
 */
export function createRoomEntry(config: RoomEntryConfig): { destroy: () => void } {
  const { container } = config;
  const title = config.title ?? 'Play with friends';
  const subtitle = config.subtitle ?? 'Start a new room, or enter a code to join a friend.';

  // PRIVATE BY DEFAULT. A public room advertises itself to strangers, so it has
  // to be something the player reached for — never a default they never saw.
  let isPublic = false;
  let browsing = false;
  let joined = false;
  let rooms: PublicRoom[] = [];
  /** Survives the repaint that toggling public/private causes. */
  let draft = '';
  let err = '';
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function leave(code: string, created: boolean): void {
    // Off the board before the screen changes: nothing may keep the mesh open
    // once the player has stopped browsing.
    browsing = false;
    clearTimeout(settleTimer);
    config.board?.close();
    config.onSubmit(code, created, created && isPublic);
  }

  function visChip(pub: boolean, name: string, meta: string): string {
    return `<button class="vis-chip${isPublic === pub ? ' on' : ''}" type="button"
      role="radio" aria-checked="${isPublic === pub}" data-pub="${pub ? 1 : 0}">
      <span class="vis-name">${escapeHtml(name)}</span>
      <span class="vis-meta">${escapeHtml(meta)}</span>
    </button>`;
  }

  function renderHome(): void {
    container.innerHTML = `
      <div class="room-entry">
        <div class="re-head">
          <h2 class="re-title">${escapeHtml(title)}</h2>
          <p class="re-sub">${escapeHtml(subtitle)}</p>
        </div>
        ${
          config.board
            ? `<div class="vis re-vis" role="radiogroup" aria-label="Who can join">
                 ${visChip(false, 'Private', 'Invite only')}
                 ${visChip(true, 'Public', 'Listed for anyone')}
               </div>
               <p class="re-note">${escapeHtml(P2P_IP_NOTE)}</p>`
            : ''
        }
        <button class="lobby-btn primary re-create" type="button">Create a ${
          config.board ? (isPublic ? 'public' : 'private') : ''
        } room</button>
        <div class="re-divider"><span>or join a friend</span></div>
        <form class="re-join" novalidate>
          <input class="re-input" type="text" inputmode="latin" autocomplete="off"
            autocapitalize="characters" spellcheck="false" maxlength="8"
            placeholder="Enter room code" aria-label="Room code" value="${escapeHtml(draft)}" />
          <button class="lobby-btn re-go" type="submit">Join</button>
        </form>
        <p class="re-error" role="alert" aria-live="polite">${escapeHtml(err)}</p>
        ${
          config.board
            ? `<div class="re-divider"><span>or find a game</span></div>
               <button class="lobby-btn re-browse" type="button">Browse public games</button>
               <p class="re-note">${escapeHtml(BROWSE_IP_NOTE)}</p>`
            : ''
        }
        ${config.onCancel ? '<button class="lobby-btn ghost re-cancel" type="button">Back</button>' : ''}
      </div>`;

    const input = container.querySelector<HTMLInputElement>('.re-input')!;
    const errEl = container.querySelector<HTMLElement>('.re-error')!;
    const showErr = (msg: string) => {
      err = msg;
      errEl.textContent = msg;
    };

    input.addEventListener('input', () => {
      const caretAtEnd = input.selectionStart === input.value.length;
      input.value = normalizeRoomCode(input.value);
      if (caretAtEnd) input.setSelectionRange(input.value.length, input.value.length);
      draft = input.value;
      if (errEl.textContent) showErr('');
    });

    for (const btn of container.querySelectorAll<HTMLButtonElement>('.vis-chip')) {
      btn.addEventListener('click', () => {
        isPublic = btn.dataset.pub === '1';
        renderHome();
      });
    }

    container.querySelector('.re-create')?.addEventListener('click', () => leave(mintCode(), true));

    container.querySelector<HTMLFormElement>('.re-join')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = normalizeRoomCode(input.value);
      if (code.length < 3) {
        showErr('Enter the room code your host shared (e.g. K7QP).');
        input.focus();
        return;
      }
      leave(code, false);
    });

    container.querySelector('.re-browse')?.addEventListener('click', () => void browse());

    if (config.onCancel) {
      container.querySelector('.re-cancel')?.addEventListener('click', () => {
        config.board?.close();
        config.onCancel!();
      });
    }
  }

  /** The ONLY thing that ever joins the board. Not page load, not the lobby. */
  async function browse(): Promise<void> {
    browsing = true;
    joined = false;
    rooms = [];
    renderBrowse();
    await config.board!.open((next) => {
      rooms = next;
      // Hearing any room at all proves the mesh is up — stop waiting on a clock.
      if (rooms.length) joined = true;
      if (browsing) renderBrowse();
    });
    if (!browsing) return;
    // Being ON the board is not the same as being connected to anyone on it: the
    // mesh forms through a public relay and takes seconds. An empty list in that
    // window means "we have not heard yet", not "nobody is there" — and saying
    // the latter is a lie the player acts on. They tap Back, and never see the
    // room that was being advertised the whole time.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      joined = true;
      if (browsing) renderBrowse();
    }, config.settleMs ?? 3000);
  }

  function stopBrowsing(): void {
    browsing = false;
    clearTimeout(settleTimer);
    config.board?.close();
    renderHome();
  }

  function roomRow(r: PublicRoom): string {
    const full = r.players >= r.max;
    return `<li><button class="re-room${r.playing ? ' playing' : ''}" type="button"
      data-code="${escapeHtml(r.code)}">
      <span class="re-room-host">${escapeHtml(r.host)}</span>
      <span class="re-room-code">${escapeHtml(r.code)}</span>
      <span class="re-room-note">${escapeHtml(r.note ?? 'Open room')}</span>
      <span class="re-room-meta">${r.players}/${r.max}${full ? ' · full' : ''}</span>
      ${
        r.playing
          ? '<span class="re-room-state">Round in progress — you would wait in the lobby</span>'
          : ''
      }
    </button></li>`;
  }

  function renderBrowse(): void {
    const body = !joined
      ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
           <span>Joining the public list…</span></div>`
      : rooms.length
        ? `<ul class="re-rooms">${rooms.map(roomRow).join('')}</ul>`
        : `<p class="re-empty">Nobody has a public room open right now. Rooms only
             appear here while someone is sitting in one waiting for players — so
             it is often empty. Start one and see who turns up.</p>`;

    container.innerHTML = `
      <div class="room-entry">
        <div class="re-head">
          <h2 class="re-title">Public games</h2>
          <p class="re-sub">Anyone can join these. Tap one to go in as a guest.</p>
        </div>
        ${body}
        <button class="lobby-btn${rooms.length ? '' : ' primary'} re-make" type="button">Create a room instead</button>
        <p class="re-note">${escapeHtml(BROWSE_IP_NOTE)}</p>
        <button class="lobby-btn ghost re-back" type="button">Back</button>
      </div>`;

    for (const btn of container.querySelectorAll<HTMLButtonElement>('.re-room')) {
      // A room off the list is SOMEONE ELSE'S. Guest, never host: created=false
      // is what keeps claimHost false, so we wait for the incumbent rather than
      // racing a stranger for their own room.
      btn.addEventListener('click', () => leave(normalizeRoomCode(btn.dataset.code!), false));
    }
    container.querySelector('.re-make')?.addEventListener('click', () => {
      browsing = false;
      config.board?.close();
      leave(mintCode(), true);
    });
    container.querySelector('.re-back')?.addEventListener('click', stopBrowsing);
  }

  renderHome();

  return {
    destroy() {
      browsing = false;
      clearTimeout(settleTimer);
      config.board?.close();
      container.innerHTML = '';
    },
  };
}

export function createLobby(config: LobbyConfig): { destroy: () => void; repaint: () => void } {
  const { net, rounds, container } = config;
  const minPlayers = config.minPlayers ?? 2;
  const maxPlayers = config.maxPlayers ?? 8;

  // The lobby renders; it does not decide. Presence, readiness, quorum and the
  // start signal all live in rematch.ts, so the first round and every rematch
  // travel the identical code path — including the frozen roster that keeps
  // player indices identical on every peer.
  function players(): LobbyPlayer[] {
    const s = rounds.state();
    // Null until the room settles. Painting a host badge before then is how both
    // players ended up looking like the host of a room that never connected.
    const host = net.hostSettled() ? net.host() : null;
    const ready = new Set(s.votes.map((v) => v.id));
    return s.present
      .map((p) => ({
        id: p.id,
        name: p.name,
        ready: ready.has(p.id),
        isHost: p.id === host,
        isSelf: p.id === net.selfId,
      }))
      .sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.id.localeCompare(b.id)));
  }

  async function share(): Promise<void> {
    const link = inviteLink(config.roomCode);
    const shareData = { title: 'Join my Hexbloom game', text: `Room ${config.roomCode}`, url: link };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* user cancelled — fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      flash('Invite link copied');
    } catch {
      flash(link);
    }
  }

  function flash(msg: string): void {
    const el = container.querySelector<HTMLElement>('.lobby-flash');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 1800);
    }
  }

  /** Repaint only on a real change — a blind interval would fight the user for
   *  focus on the invite-link field. */
  let painted = '';

  /**
   * A round is running that we are not in. Keep the ready toggle live so the
   * player is queued for the next round the moment it opens, instead of having
   * to notice the game ended and tap in time.
   *
   * Ported from the engine's lobby, which this file forks. Without it an
   * unseated peer got a BLANK screen: `render()` bailed on phase 'playing' and
   * nothing else owned the container. That is precisely what "I got ejected"
   * looked like from the player's seat (01-DIAGNOSIS §3b) — engine v1.1.0 stops
   * the roster being frozen out of a half-formed mesh, but a peer can still
   * legitimately arrive mid-round, and it must land somewhere honest.
   */
  function renderSpectating(round: number): void {
    const s = rounds.state();
    const key = JSON.stringify([round, s.voted, s.present.length, 'spectating']);
    if (key === painted) return;
    painted = key;

    container.innerHTML = `
      <div class="lobby lobby-spectating">
        <div class="lobby-head">
          <h2 class="lobby-title">Round ${round} in progress</h2>
          <p class="lobby-sub">You're in the next one — ${s.present.length} in the room</p>
        </div>
        <div class="lobby-searching">
          <span class="spinner" aria-hidden="true"></span>
          <span>Waiting for this round to finish…</span>
        </div>
        <div class="lobby-actions">
          <button class="lobby-btn primary lobby-ready" type="button">${
            s.voted ? "You're in for the next round" : 'Ready me for the next round'
          }</button>
          ${config.onCancel ? '<button class="lobby-btn ghost lobby-cancel" type="button">Leave room</button>' : ''}
        </div>
        <div class="lobby-flash" role="status" aria-live="polite"></div>
      </div>`;

    container.querySelector('.lobby-ready')?.addEventListener('click', () => {
      if (rounds.state().voted) rounds.unvote();
      else rounds.vote();
      render();
    });
    container.querySelector('.lobby-cancel')?.addEventListener('click', () => config.onCancel?.());
  }

  function render(): void {
    const s = rounds.state();
    if (s.phase === 'playing') {
      // Seated: the game owns the screen, so the lobby must keep its hands off.
      if (s.seated) return;
      renderSpectating(s.round);
      return;
    }
    const ps = players();
    const key = JSON.stringify([ps, s.canStart, s.voted, net.hostSettled(), config.modeSlot?.() ?? '']);
    if (key === painted) return;
    painted = key;

    const link = inviteLink(config.roomCode);
    container.innerHTML = `
      <div class="lobby">
        <div class="lobby-head">
          <h2 class="lobby-title">Room <span class="lobby-code">${escapeHtml(config.roomCode)}</span></h2>
          <p class="lobby-sub">${ps.length}/${maxPlayers} players · peer-to-peer, no server</p>
        </div>
        <div class="lobby-invite">
          <input class="lobby-link" readonly value="${escapeHtml(link)}" aria-label="Invite link" />
          <button class="lobby-btn lobby-share" type="button">Invite</button>
        </div>
        <ul class="lobby-players">
          ${ps
            .map(
              (p) => `<li class="lobby-player${p.isSelf ? ' is-self' : ''}">
                <span class="lobby-dot ${p.ready ? 'ready' : ''}"></span>
                <span class="lobby-name">${escapeHtml(p.name)}${p.isSelf ? ' (you)' : ''}</span>
                ${p.isHost ? '<span class="lobby-badge">HOST</span>' : ''}
                ${p.ready ? '<span class="lobby-badge ok">READY</span>' : ''}
              </li>`,
            )
            .join('')}
        </ul>
        ${
          !net.hostSettled()
            ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
                 <span>Connecting to the room…</span></div>`
            : ps.length < minPlayers
              ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
                 <span>Looking for ${minPlayers - ps.length} more player${minPlayers - ps.length === 1 ? '' : 's'}… share the invite link</span></div>`
              : ''
        }
        ${config.modeSlot ? config.modeSlot() : ''}
        <div class="lobby-actions">
          <button class="lobby-btn primary lobby-ready" type="button" ${net.hostSettled() ? '' : 'disabled'}>${s.voted ? 'Not ready' : "I'm ready"}</button>
          ${
            net.isHost()
              ? `<button class="lobby-btn lobby-start" type="button" ${s.canStart ? '' : 'disabled'}>
                   ${ps.length < minPlayers ? `Waiting for ${minPlayers - ps.length} more…` : 'Start game'}
                 </button>`
              : `<p class="lobby-wait"><span class="spinner sm" aria-hidden="true"></span> Waiting for the host to start…</p>`
          }
          ${config.onCancel ? '<button class="lobby-btn ghost lobby-cancel" type="button">Leave room</button>' : ''}
        </div>
        <div class="lobby-flash" role="status" aria-live="polite"></div>
      </div>`;

    config.onModeMount?.();
    container.querySelector('.lobby-share')?.addEventListener('click', () => void share());
    container.querySelector('.lobby-ready')?.addEventListener('click', () => {
      if (rounds.state().voted) rounds.unvote();
      else rounds.vote();
      render();
    });
    container.querySelector('.lobby-start')?.addEventListener('click', () => rounds.go());
    container.querySelector('.lobby-cancel')?.addEventListener('click', () => config.onCancel?.());
    container.querySelector<HTMLInputElement>('.lobby-link')?.addEventListener('focus', (e) => {
      (e.target as HTMLInputElement).select();
    });
  }

  // Spot a host transfer (net.ts re-elects when the host leaves) so a newly
  // promoted peer learns the Start button is now theirs.
  let lastHost = net.host();
  const poll = setInterval(() => {
    render();
    const host = net.host();
    if (host !== lastHost) {
      const wasHost = lastHost === net.selfId;
      lastHost = host;
      if (net.isHost() && !wasHost) flash("The host left — you're the host now");
    }
  }, 600);

  render();

  return {
    destroy() {
      clearInterval(poll);
    },
    repaint() {
      painted = '';
      render();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
