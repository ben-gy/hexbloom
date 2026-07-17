/**
 * net.ts — zero-backend P2P networking for Hexbloom. Copied from the
 * gh-game-factory patterns/ engine; keep the two in step.
 *
 * Thin, game-friendly wrapper over Trystero (https://github.com/dmotz/trystero).
 * Trystero establishes an encrypted WebRTC mesh between everyone in a room using
 * FREE public infrastructure for the initial handshake — no server of your own,
 * which is exactly what GitHub Pages hosting needs. The default strategy here is
 * `nostr` (public Nostr relays); swap the import for `trystero/torrent` or
 * `trystero/mqtt` if relays are flaky in your region (see README).
 *
 * Netcode model this wrapper assumes: **host-authoritative star**. Every peer
 * runs the same election (lexicographically smallest peer id, self included) so
 * they all independently agree on who the host is — no handshake needed, and it
 * re-elects automatically when the host leaves. The host owns authoritative game
 * state and broadcasts snapshots; clients send inputs. For deterministic
 * lockstep games, pair this with rng.ts (shared seed) instead.
 *
 * Trystero limits to remember:
 *  - Action names (channels) must be <= 12 bytes. Keep them short: 'mv','snap'.
 *  - Payloads are JSON-serialized (or ArrayBuffer/Blob for binary). Keep small.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE ROOM PER SESSION — THE RULE THAT MATTERS MOST
 *
 * Never leave a room and rejoin the same one to "reset" for a rematch. It looks
 * harmless and it is catastrophic. Trystero memoizes `joinRoom` on appId+roomId
 * (strategy.js: `if (occupiedRooms[appId]?.[roomId]) return occupiedRooms...`)
 * while `room.leave()` is ASYNC and defers its real teardown behind a ~99ms
 * timer (room.js). So `net.leave(); createNet(...)` in the same tick hands you
 * back the very room object that is about to be destroyed. Moments later the
 * deferred teardown clears the announce timer and unsubscribes from every relay
 * — your "fresh" Net is a corpse: permanently deaf, roster of one, and every
 * peer elects itself host. Both players sit in the right room code, alone.
 *
 * Keep the mesh alive and version the rounds inside it — see rematch.ts.
 * `createNet` enforces this: rejoining a room that is still tearing down throws.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Default = nostr strategy. To switch: `import { joinRoom, selfId } from 'trystero/torrent'`.
import { joinRoom, selfId } from 'trystero';

export type PeerId = string;

/** Cheap deep-ish JSON-safe payloads. Trystero handles ArrayBuffer/Blob too. */
export type NetData = unknown;

export interface NetConfig {
  /** Namespaces your game on the shared signaling infra. Use the repo slug. */
  appId: string;
  /** Room id — the shareable code. Peers with the same appId+roomId connect. */
  roomId: string;
  /** Optional shared secret — end-to-end encrypts signaling AND data channels.
   *  Derive it from a code in the invite link for private rooms. */
  password?: string;
}

export interface NetHandlers {
  /** A peer connected. */
  onPeerJoin?: (id: PeerId) => void;
  /** A peer disconnected (tab closed, network dropped). */
  onPeerLeave?: (id: PeerId) => void;
  /** Roster changed (join OR leave). Gives the full, sorted peer list + self. */
  onPeers?: (peers: PeerId[], selfId: PeerId) => void;
  /** The elected host changed (initial election, or host left). */
  onHostChange?: (hostId: PeerId, isSelfHost: boolean) => void;
}

/** Unsubscribe a receiver registered via `channel()`. */
export type Unsubscribe = () => void;

export interface Net {
  /** This peer's stable id for the session. */
  readonly selfId: PeerId;
  /** All connected peers plus self, sorted — identical order on every client. */
  peers(): PeerId[];
  /** The currently elected host id. */
  host(): PeerId;
  /** True when THIS peer is the authoritative host. */
  isHost(): boolean;
  /** How many are in the room right now (peers + self). */
  count(): number;
  /**
   * Register a receive handler for a named channel. Returns a `send` function.
   * `send(data)` broadcasts to all; `send(data, toPeers)` targets a subset.
   *
   * Handlers FAN OUT: calling channel() twice with the same name registers both
   * receivers and both fire. (The old build memoized on name and silently threw
   * the second receiver away, which made any second subsystem on a live net —
   * a rematch lobby, a fresh round — permanently deaf.) Use `send.off()` to
   * detach one receiver without disturbing the others.
   */
  channel<T = NetData>(
    name: string,
    onReceive: (data: T, from: PeerId) => void,
  ): ((data: T, toPeers?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
  /** Round-trip latency (ms) to a peer, measured via the ping channel. */
  ping(id: PeerId): Promise<number>;
  /**
   * Tear down the room and all channels. Call on leave — NOT between rounds.
   * Resolves once Trystero has actually retired the room, so it is safe to join
   * the same room id again afterwards. Always `await` it before any rejoin.
   */
  leave(): Promise<void>;
}

/** min-id election: everyone computes the same host from the same sorted list. */
function electHost(peers: PeerId[]): PeerId {
  return peers.reduce((min, p) => (p < min ? p : min), peers[0]);
}

// ── join registry ───────────────────────────────────────────────────────────
// Tracks which rooms this page has open so the leave/rejoin trap above fails
// loudly at the call site instead of silently producing a dead mesh. Also backs
// netStats() so tests can assert the "one join per session" invariant directly,
// without needing a network, a relay model, or a browser.

type RoomPhase = 'joined' | 'leaving';
const registry = new Map<string, RoomPhase>();
let joinCount = 0;

const roomKey = (appId: string, roomId: string): string => `${appId}|${roomId}`;

export interface NetStats {
  /** Total createNet() calls since reset — the rematch invariant asserts this. */
  joins: number;
  /** Rooms currently joined or tearing down. */
  active: string[];
}

/** Introspection for tests and dev HUDs. */
export function netStats(): NetStats {
  return {
    joins: joinCount,
    active: [...registry.keys()].map((k) => k.replace('|', '/')),
  };
}

/** Test-only: clear the registry between cases. */
export function resetNetStats(): void {
  registry.clear();
  joinCount = 0;
}

export function createNet(config: NetConfig, handlers: NetHandlers = {}): Net {
  const key = roomKey(config.appId, config.roomId);
  const phase = registry.get(key);
  if (phase === 'leaving') {
    throw new Error(
      `net: rejoined "${config.roomId}" while it was still tearing down. Trystero ` +
        `would hand back the dying room and the mesh would never form (both peers ` +
        `become host, alone). For a rematch, keep the Net and start a new round ` +
        `(see rematch.ts). To genuinely leave and come back, "await net.leave()" first.`,
    );
  }
  if (phase === 'joined') {
    throw new Error(
      `net: already joined "${config.roomId}" — reuse the existing Net rather than ` +
        `creating a second one for the same room.`,
    );
  }
  registry.set(key, 'joined');
  joinCount++;

  const room = joinRoom(
    { appId: config.appId, ...(config.password ? { password: config.password } : {}) },
    config.roomId,
  );

  /** name -> the fan-out set of receivers, plus the memoized trystero sender. */
  interface Chan {
    send: (d: NetData, to?: PeerId | PeerId[]) => void;
    handlers: Set<(data: never, from: PeerId) => void>;
  }
  const chans = new Map<string, Chan>();
  let currentHost: PeerId = selfId;

  const roster = (): PeerId[] => [selfId, ...Object.keys(room.getPeers())].sort();

  function recomputeHost(): void {
    const next = electHost(roster());
    if (next !== currentHost) {
      currentHost = next;
      handlers.onHostChange?.(currentHost, currentHost === selfId);
    }
  }

  // Seed the initial host (self, until peers arrive) so callers can render state
  // on the very first frame without waiting for a peer event.
  handlers.onHostChange?.(currentHost, true);

  room.onPeerJoin((id) => {
    handlers.onPeerJoin?.(id);
    handlers.onPeers?.(roster(), selfId);
    recomputeHost();
  });

  room.onPeerLeave((id) => {
    handlers.onPeerLeave?.(id);
    handlers.onPeers?.(roster(), selfId);
    recomputeHost();
  });

  // Built-in ping/pong channel for latency HUDs and lag compensation.
  const pending = new Map<string, (rtt: number) => void>();
  const [sendPing, getPing] = room.makeAction<{ t: number; id: string; pong?: boolean }>('ping');
  getPing((msg, from) => {
    if (msg.pong) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(performance.now() - msg.t);
      }
    } else {
      sendPing({ ...msg, pong: true }, from);
    }
  });

  return {
    selfId,
    peers: roster,
    host: () => currentHost,
    isHost: () => currentHost === selfId,
    count: () => roster().length,

    channel<T = NetData>(name: string, onReceive: (data: T, from: PeerId) => void) {
      if (name.length > 12) {
        // Trystero hard-limits action names to 12 bytes; fail loud in dev.
        throw new Error(`net channel "${name}" exceeds 12 bytes`);
      }
      let chan = chans.get(name);
      if (!chan) {
        // Trystero constrains payloads to a JSON/binary type; our channels are
        // generic JSON so we bridge through the untyped makeAction here.
        const make = room.makeAction as unknown as (
          n: string,
        ) => [
          (d: NetData, to?: PeerId | PeerId[]) => void,
          (cb: (d: NetData, from: PeerId) => void) => void,
        ];
        const [send, get] = make(name);
        const created: Chan = { send, handlers: new Set() };
        // One trystero receiver per name, fanning out to every subscriber. Copy
        // the set first so a handler that unsubscribes mid-dispatch is safe.
        get((data, from) => {
          for (const h of [...created.handlers]) (h as (d: NetData, f: PeerId) => void)(data, from);
        });
        chans.set(name, created);
        chan = created;
      }
      const handler = onReceive as (data: never, from: PeerId) => void;
      chan.handlers.add(handler);

      const send = ((data: T, to?: PeerId | PeerId[]) => chan!.send(data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: Unsubscribe };
      send.off = () => {
        chan!.handlers.delete(handler);
      };
      return send;
    },

    ping(id: PeerId) {
      return new Promise<number>((resolve) => {
        const pid = `${performance.now()}-${Math.floor(Math.random() * 1e6)}`;
        pending.set(pid, resolve);
        sendPing({ t: performance.now(), id: pid }, id);
        setTimeout(() => {
          if (pending.delete(pid)) resolve(Infinity);
        }, 5000);
      });
    },

    async leave() {
      // Mark 'leaving' BEFORE awaiting: trystero keeps the room in its own cache
      // until teardown completes, so any join in that window aliases the corpse.
      // The registry entry is what turns that silent trap into a thrown error.
      registry.set(key, 'leaving');
      try {
        await room.leave();
      } finally {
        registry.delete(key);
        chans.clear();
        pending.clear();
      }
    },
  };
}

/** Export selfId for callers that need it before createNet (e.g. UI seeds). */
export { selfId };
