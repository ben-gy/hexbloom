/**
 * lobby.ts — a drop-in peer-to-peer lobby built on net.ts. Copied from the
 * gh-game-factory patterns/ engine. Style .lobby-* / .spinner in the game CSS.
 */

import type { Net, PeerId } from './net';

export interface LobbyPlayer {
  id: PeerId;
  name: string;
  ready: boolean;
  isHost: boolean;
  isSelf: boolean;
}

export interface LobbyStartInfo {
  seed: number;
  players: LobbyPlayer[];
  isHost: boolean;
}

export interface LobbyConfig {
  container: HTMLElement;
  net: Net;
  roomCode: string;
  playerName: string;
  minPlayers?: number;
  maxPlayers?: number;
  onStart: (info: LobbyStartInfo) => void;
}

interface Presence {
  name: string;
  ready: boolean;
}

export function getOrCreateRoomCode(): string {
  const url = new URL(location.href);
  const existing = url.searchParams.get('room');
  if (existing) return existing.toUpperCase().slice(0, 8);
  const code = mintCode();
  url.searchParams.set('room', code);
  history.replaceState(null, '', url.toString());
  return code;
}

function mintCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function inviteLink(roomCode: string): string {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  url.hash = '';
  return url.toString();
}

export function createLobby(config: LobbyConfig): { destroy: () => void } {
  const { net, container } = config;
  const minPlayers = config.minPlayers ?? 2;
  const maxPlayers = config.maxPlayers ?? 8;

  const presence = new Map<PeerId, Presence>();
  presence.set(net.selfId, { name: config.playerName, ready: false });
  let started = false;

  const sendPres = net.channel<Presence & { id: PeerId }>('pres', (p) => {
    presence.set(p.id, { name: p.name, ready: p.ready });
    render();
  });
  const reqSync = net.channel<null>('preq', (_d, from) => {
    sendPres({ id: net.selfId, ...self() }, from);
  });
  const sendGo = net.channel<{ seed: number }>('go', ({ seed }) => begin(seed));

  function self(): Presence {
    return presence.get(net.selfId)!;
  }
  function broadcastPresence(): void {
    sendPres({ id: net.selfId, ...self() });
  }

  const origList = container;

  function players(): LobbyPlayer[] {
    const host = net.host();
    return net
      .peers()
      .map((id) => {
        const p = presence.get(id) ?? { name: '…', ready: false };
        return { id, name: p.name, ready: p.ready, isHost: id === host, isSelf: id === net.selfId };
      })
      .sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.id.localeCompare(b.id)));
  }

  function canStart(): boolean {
    const ps = players();
    return net.isHost() && ps.length >= minPlayers && ps.every((p) => p.ready || p.isHost);
  }

  function begin(seed: number): void {
    if (started) return;
    started = true;
    config.onStart({ seed, players: players(), isHost: net.isHost() });
  }

  function toggleReady(): void {
    const me = self();
    presence.set(net.selfId, { ...me, ready: !me.ready });
    broadcastPresence();
    render();
  }

  async function share(): Promise<void> {
    const link = inviteLink(config.roomCode);
    const shareData = { title: 'Join my Hexbloom game', text: `Room ${config.roomCode}`, url: link };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* cancelled — fall through to copy */
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

  function start(): void {
    if (!canStart()) return;
    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    sendGo({ seed });
    begin(seed);
  }

  function render(): void {
    if (started) return;
    const ps = players();
    const link = inviteLink(config.roomCode);
    origList.innerHTML = `
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
                <span class="lobby-dot ${p.ready || p.isHost ? 'ready' : ''}"></span>
                <span class="lobby-name">${escapeHtml(p.name)}${p.isSelf ? ' (you)' : ''}</span>
                ${p.isHost ? '<span class="lobby-badge">HOST</span>' : p.ready ? '<span class="lobby-badge ok">READY</span>' : ''}
              </li>`,
            )
            .join('')}
        </ul>
        ${
          ps.length < minPlayers
            ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
                 <span>Looking for ${minPlayers - ps.length} more player${minPlayers - ps.length === 1 ? '' : 's'}… share the invite link</span></div>`
            : ''
        }
        <div class="lobby-actions">
          ${
            net.isHost()
              ? `<button class="lobby-btn lobby-start" type="button" ${canStart() ? '' : 'disabled'}>
                   ${ps.length < minPlayers ? `Waiting for ${minPlayers - ps.length} more…` : 'Start game'}
                 </button>`
              : `<button class="lobby-btn lobby-ready" type="button">${self().ready ? 'Not ready' : "I'm ready"}</button>
                 <p class="lobby-wait"><span class="spinner sm" aria-hidden="true"></span> Waiting for the host to start…</p>`
          }
        </div>
        <div class="lobby-flash" role="status" aria-live="polite"></div>
      </div>`;

    container.querySelector('.lobby-share')?.addEventListener('click', () => void share());
    container.querySelector('.lobby-ready')?.addEventListener('click', toggleReady);
    container.querySelector('.lobby-start')?.addEventListener('click', start);
    container.querySelector<HTMLInputElement>('.lobby-link')?.addEventListener('focus', (e) => {
      (e.target as HTMLInputElement).select();
    });
  }

  const poll = setInterval(() => {
    if (!started) {
      reqSync(null);
      render();
    }
  }, 1500);

  broadcastPresence();
  reqSync(null);
  render();

  return {
    destroy() {
      clearInterval(poll);
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
