/**
 * net-game.ts — multiplayer glue for Hexbloom. Host-authoritative: the elected
 * host holds the canonical board, applies each move, and broadcasts a full
 * snapshot (the board is tiny, so full snapshots are simplest and desync-proof).
 * Clients send their chosen colour and render snapshots.
 *
 * Seating is derived identically on every peer from the sorted lobby roster, so
 * player↔peer mapping needs no negotiation. Late joiners after start spectate.
 * If the host leaves, net.ts re-elects and the new host re-broadcasts its last
 * snapshot and carries on. If a seated player disconnects on their turn, the
 * host plays a greedy move for them so the game never stalls.
 */

import type { Net, PeerId } from './engine/net';
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
  private sendMove: (data: { color: number }, to?: PeerId | PeerId[]) => void;
  private sendSnap: (data: Snapshot, to?: PeerId | PeerId[]) => void;
  private requestSync: (data: null, to?: PeerId | PeerId[]) => void;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(cfg: NetGameConfig) {
    this.net = cfg.net;
    this.seats = cfg.seats;
    this.onUpdate = cfg.onUpdate;
    this.state = generateBoard(cfg.seed, { players: Math.max(2, cfg.seats.length) });

    this.sendMove = this.net.channel<{ color: number }>('mv', (data, from) => {
      if (!this.net.isHost()) return;
      const seat = this.seats.indexOf(from);
      if (seat < 0 || seat !== this.state.turn || this.state.finished) return;
      this.hostApply(seat, data.color);
    });

    this.sendSnap = this.net.channel<Snapshot>('snap', (snap) => {
      if (this.net.isHost()) return; // host is the source of truth
      this.state = snap.state;
      this.emit(snap.absorbed, snap.mover);
      this.scheduleAutoMove();
    });

    this.requestSync = this.net.channel<null>('sync', (_d, from) => {
      if (this.net.isHost()) {
        this.sendSnap({ state: this.state, absorbed: [], mover: -1 }, from);
      }
    });

    // Host announces the opening position; everyone else asks for it in case
    // they mounted a beat late.
    if (this.net.isHost()) {
      this.broadcastSnap([], -1);
    } else {
      this.requestSync(null);
    }
    this.emit([], -1);
    this.scheduleAutoMove();
  }

  /** Whether this peer is a seated player (vs a spectator). */
  mySeat(): number {
    return this.seats.indexOf(this.net.selfId);
  }

  isMyTurn(): boolean {
    return !this.state.finished && this.mySeat() === this.state.turn && this.mySeat() >= 0;
  }

  getState(): GameState {
    return this.state;
  }

  /** Play a colour for this peer's seat (no-op if it isn't our turn). */
  play(color: number): void {
    if (!this.isMyTurn()) return;
    const seat = this.mySeat();
    if (this.net.isHost()) {
      this.hostApply(seat, color);
    } else {
      this.sendMove({ color }, this.net.host());
    }
  }

  /** Called by main when net re-elects a host. */
  onHostChanged(isSelfHost: boolean): void {
    if (isSelfHost && !this.destroyed) {
      // Adopt our last snapshot as canonical and re-sync everyone.
      this.broadcastSnap([], -1);
      this.scheduleAutoMove();
    }
  }

  /** Called by main when the roster changes (peer join/leave). */
  onRoster(): void {
    if (this.net.isHost()) this.scheduleAutoMove();
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
    if (this.destroyed || !this.net.isHost() || this.state.finished) return;
    const seat = this.state.turn;
    if (seat >= 0 && seat < this.seats.length && !this.seatConnected(seat)) {
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        if (this.destroyed || !this.net.isHost() || this.state.finished) return;
        if (this.state.turn === seat && !this.seatConnected(seat)) {
          const color = chooseAiColor(this.state, seat, 'normal');
          this.hostApply(seat, color);
        }
      }, 900);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }
}
