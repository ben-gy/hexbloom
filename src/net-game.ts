/**
 * net-game.ts — multiplayer glue for Hexbloom. Host-authoritative: the elected
 * host holds the canonical board, applies each move, and broadcasts a full
 * snapshot (the board is tiny, so full snapshots are simplest and desync-proof).
 * Clients send their chosen colour and render snapshots.
 *
 * Seating arrives FROZEN from engine/rematch.ts — the host stamps the roster into
 * the round-start message, so index N is the same player on every peer with no
 * negotiation and no local re-derivation.
 *
 * Authority follows that frozen roster, NOT net.host(). The room outlives the
 * round, so anyone may walk in mid-game; net.host() is a min-id election over
 * everyone present, and a joiner with a smaller peer id would win it, seize
 * authority over a match it holds no state for, and freeze the board forever.
 * A peer outside the round's roster is a spectator and can never be its host.
 * Host migration inside the roster still works: the round host is simply the
 * smallest CONNECTED seat, so a real player leaving promotes the next one.
 */

import type { Net, PeerId, Unsubscribe } from './engine/net';
import {
  applyMove,
  chooseAiColor,
  generateBoard,
  type GameState,
  type MoveResult,
} from './game';

export interface NetGameMeta {
  absorbed: number[];
  mover: number;
}

export interface NetGameConfig {
  net: Net;
  seed: number;
  /** Canonical seating: peer ids in ascending order. Index = player number. */
  seats: PeerId[];
  onUpdate: (state: GameState, meta: NetGameMeta) => void;
}

interface Snapshot {
  state: GameState;
  absorbed: number[];
  mover: number;
}

export class NetGame {
  private net: Net;
  private seats: PeerId[];
  private state: GameState;
  private onUpdate: (state: GameState, meta: NetGameMeta) => void;
  private sendMove: ((data: { color: number }, to?: PeerId | PeerId[]) => void) & {
    off: Unsubscribe;
  };
  private sendSnap: ((data: Snapshot, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
  private requestSync: ((data: null, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private lastRoundHost: PeerId | null;

  constructor(cfg: NetGameConfig) {
    this.net = cfg.net;
    this.seats = cfg.seats;
    this.onUpdate = cfg.onUpdate;
    this.state = generateBoard(cfg.seed, { players: Math.max(2, cfg.seats.length) });
    this.lastRoundHost = this.roundHost();

    this.sendMove = this.net.channel<{ color: number }>('mv', (data, from) => {
      if (!this.isRoundHost()) return;
      const seat = this.seats.indexOf(from);
      if (seat < 0 || seat !== this.state.turn || this.state.finished) return;
      this.hostApply(seat, data.color);
    });

    this.sendSnap = this.net.channel<Snapshot>('snap', (snap, from) => {
      if (this.isRoundHost()) return; // the round host is the source of truth
      // Only the round host may dictate state. A spectator or a stale peer that
      // still holds this channel must not be able to rewrite a live board.
      if (from !== this.roundHost()) return;
      this.state = snap.state;
      this.emit(snap.absorbed, snap.mover);
      this.scheduleAutoMove();
    });

    this.requestSync = this.net.channel<null>('sync', (_d, from) => {
      if (this.isRoundHost()) {
        this.sendSnap({ state: this.state, absorbed: [], mover: -1 }, from);
      }
    });

    // Host announces the opening position; everyone else asks for it in case
    // they mounted a beat late.
    if (this.isRoundHost()) {
      this.broadcastSnap([], -1);
    } else {
      this.requestSync(null);
    }
    this.emit([], -1);
    this.scheduleAutoMove();
  }

  /**
   * The authority for THIS round: the lowest-id seat still connected. Derived
   * from the frozen roster, so a mid-game joiner — who may well win net.host()'s
   * min-id election — is never it.
   */
  private roundHost(): PeerId | null {
    const here = new Set(this.net.peers());
    const live = this.seats.filter((id) => here.has(id)).sort();
    return live[0] ?? null;
  }

  private isRoundHost(): boolean {
    return this.roundHost() === this.net.selfId;
  }

  /** Whether this peer is a seated player (vs a spectator). */
  mySeat(): number {
    return this.seats.indexOf(this.net.selfId);
  }

  isMyTurn(): boolean {
    return !this.state.finished && this.mySeat() === this.state.turn && this.mySeat() >= 0;
  }

  /** True when this peer holds authority over the round (tests + HUD). */
  isHost(): boolean {
    return this.isRoundHost();
  }

  getState(): GameState {
    return this.state;
  }

  /** Play a colour for this peer's seat (no-op if it isn't our turn). */
  play(color: number): void {
    if (!this.isMyTurn()) return;
    const seat = this.mySeat();
    if (this.isRoundHost()) {
      this.hostApply(seat, color);
    } else {
      const host = this.roundHost();
      if (host) this.sendMove({ color }, host);
    }
  }

  /**
   * Called by main when the roster changes (peer join/leave). A seat dropping out
   * can promote us to round host; adopt our last snapshot as canonical and
   * re-sync everyone so the match carries on where it left off.
   */
  onRoster(): void {
    if (this.destroyed) return;
    const host = this.roundHost();
    const promoted = host !== this.lastRoundHost && host === this.net.selfId;
    this.lastRoundHost = host;
    if (promoted) this.broadcastSnap([], -1);
    if (this.isRoundHost()) this.scheduleAutoMove();
  }

  private hostApply(seat: number, color: number): void {
    const res: MoveResult = applyMove(this.state, seat, color);
    if (res.state === this.state) return; // illegal / no-op
    this.state = res.state;
    this.broadcastSnap(res.absorbed, seat);
    this.emit(res.absorbed, seat);
    this.scheduleAutoMove();
  }

  private broadcastSnap(absorbed: number[], mover: number): void {
    this.sendSnap({ state: this.state, absorbed, mover });
  }

  private emit(absorbed: number[], mover: number): void {
    this.onUpdate(this.state, { absorbed, mover });
  }

  private seatConnected(seat: number): boolean {
    return this.net.peers().includes(this.seats[seat]);
  }

  /**
   * If it's a disconnected seat's turn, the host auto-plays a greedy move after
   * a short delay so the game keeps moving. setTimeout (not rAF) so it still
   * fires when the host tab is backgrounded.
   */
  private scheduleAutoMove(): void {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
    if (this.destroyed || !this.isRoundHost() || this.state.finished) return;
    const seat = this.state.turn;
    if (seat >= 0 && seat < this.seats.length && !this.seatConnected(seat)) {
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        if (this.destroyed || !this.isRoundHost() || this.state.finished) return;
        if (this.state.turn === seat && !this.seatConnected(seat)) {
          const color = chooseAiColor(this.state, seat, 'normal');
          this.hostApply(seat, color);
        }
      }, 900);
    }
  }

  /**
   * Detach this round's receivers from the shared Net. The Net now outlives the
   * round (it spans the whole room) and channel() fans out to every subscriber —
   * so without this, a finished round keeps listening: its old host would resolve
   * the next round's 'mv' inputs against a dead board and broadcast snapshots of
   * it over the live match.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.sendMove.off();
    this.sendSnap.off();
    this.requestSync.off();
  }
}
