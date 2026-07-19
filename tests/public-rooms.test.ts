/**
 * public-rooms.test.ts — the privacy contract of the public room list.
 *
 * noticeboard.test.ts covers the wire: who hears what, and what expires. This
 * file covers the promise made to the player, which is a different thing and the
 * one that actually matters:
 *
 *   - a private room is INVISIBLE — it never announces, ever;
 *   - a listed room stops being listed the moment it starts, goes private, or
 *     the host leaves;
 *   - nothing joins the board until the player taps Browse;
 *   - a room taken off the list is someone else's, so you go in as a GUEST.
 *
 * The board is WebRTC: being on it hands your IP to strangers. Every one of
 * these is a leak if it regresses, so none of them is asserted through a mock
 * of the thing under test — the fake here is the board, and the code deciding
 * is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createListing,
  createRoomEntry,
  roomAd,
  type BoardAccess,
  type ListingState,
} from '../src/engine/lobby';
import type { PublicRoom, RoomAd } from '@ben-gy/game-engine/noticeboard';

/** A board that records what it was asked to do, and never touches a network. */
function fakeBoard(): BoardAccess & {
  ads: RoomAd[];
  opens: number;
  closes: number;
  push: (rooms: PublicRoom[]) => void;
} {
  let listener: ((r: PublicRoom[]) => void) | null = null;
  return {
    ads: [],
    opens: 0,
    closes: 0,
    async open(onRooms) {
      this.opens++;
      listener = onRooms;
      onRooms([]);
    },
    async announce(ad) {
      this.ads.push(ad);
    },
    close() {
      this.closes++;
      listener = null;
    },
    push(rooms) {
      listener?.(rooms);
    },
  };
}

const LOBBY: ListingState = {
  isPublic: true,
  isHost: true,
  inLobby: true,
  playing: false,
  code: 'ABCD',
  host: 'Ann',
  players: 2,
  max: 4,
  note: 'Bloom',
};

describe('roomAd — the one rule that decides a listing', () => {
  it('advertises a public room the host is sitting in', () => {
    expect(roomAd(LOBBY)).toEqual({
      code: 'ABCD',
      host: 'Ann',
      players: 2,
      max: 4,
      playing: false,
      note: 'Bloom',
    });
  });

  it('never advertises a private room', () => {
    expect(roomAd({ ...LOBBY, isPublic: false })).toBeNull();
  });

  it('does not advertise from a guest — only the host lists a room', () => {
    expect(roomAd({ ...LOBBY, isHost: false })).toBeNull();
  });

  it('does not advertise a round in progress', () => {
    expect(roomAd({ ...LOBBY, playing: true })).toBeNull();
    expect(roomAd({ ...LOBBY, inLobby: false })).toBeNull();
  });
});

describe('createListing', () => {
  it('announces only when the room is public', () => {
    const board = fakeBoard();
    const listing = createListing(board);

    listing.sync({ ...LOBBY, isPublic: false });
    expect(board.ads).toEqual([]);
    expect(board.opens).toBe(0);

    listing.sync(LOBBY);
    expect(board.ads).toHaveLength(1);
    expect(board.ads[0].code).toBe('ABCD');
    expect(board.ads[0].note).toBe('Bloom');
  });

  it('carries the live player count and the mode note', () => {
    const board = fakeBoard();
    const listing = createListing(board);
    listing.sync(LOBBY);
    listing.sync({ ...LOBBY, players: 3, note: 'Wilds' });
    expect(board.ads.map((a) => [a.players, a.note])).toEqual([
      [2, 'Bloom'],
      [3, 'Wilds'],
    ]);
  });

  it('does not re-announce an unchanged room — the board already re-broadcasts', () => {
    const board = fakeBoard();
    const listing = createListing(board);
    listing.sync(LOBBY);
    listing.sync(LOBBY);
    listing.sync(LOBBY);
    expect(board.ads).toHaveLength(1);
  });

  it('gets off the board when the round starts', () => {
    const board = fakeBoard();
    const listing = createListing(board);
    listing.sync(LOBBY);
    expect(board.closes).toBe(0);

    listing.sync({ ...LOBBY, playing: true, inLobby: false });
    // close(), not just unannounce(): a started room has no reason to hold a
    // mesh of strangers open in the background.
    expect(board.closes).toBe(1);
  });

  it('gets off the board when the room goes private', () => {
    const board = fakeBoard();
    const listing = createListing(board);
    listing.sync(LOBBY);
    listing.sync({ ...LOBBY, isPublic: false });
    expect(board.closes).toBe(1);
    expect(board.ads).toHaveLength(1);
  });

  it('gets off the board on leave', () => {
    const board = fakeBoard();
    const listing = createListing(board);
    listing.sync(LOBBY);
    listing.close();
    expect(board.closes).toBe(1);
  });

  it('re-lists after going private and public again', () => {
    const board = fakeBoard();
    const listing = createListing(board);
    listing.sync(LOBBY);
    listing.sync({ ...LOBBY, isPublic: false });
    listing.sync(LOBBY);
    expect(board.ads).toHaveLength(2);
  });
});

describe('room entry — browsing is opt-in', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  function entry(board: BoardAccess, settleMs = 0, onSubmit = vi.fn()) {
    const e = createRoomEntry({ container, board, settleMs, onSubmit, onCancel: () => {} });
    return { e, onSubmit };
  }

  function click(sel: string): void {
    container.querySelector<HTMLElement>(sel)!.click();
  }

  it('does not touch the board just because the screen opened', () => {
    const board = fakeBoard();
    entry(board);
    // The whole point: a player who only plays with friends never meshes with
    // strangers. Opening this screen is not consent.
    expect(board.opens).toBe(0);
  });

  it('joins the board only when Browse is tapped', async () => {
    const board = fakeBoard();
    entry(board);
    click('.re-browse');
    await vi.waitFor(() => expect(board.opens).toBe(1));
  });

  it('leaves the board again on Back', async () => {
    const board = fakeBoard();
    entry(board);
    click('.re-browse');
    await vi.waitFor(() => expect(container.querySelector('.re-back')).toBeTruthy());
    click('.re-back');
    expect(board.closes).toBeGreaterThan(0);
    expect(container.querySelector('.re-browse')).toBeTruthy();
  });

  it('leaves the board when the screen is destroyed', async () => {
    const board = fakeBoard();
    const { e } = entry(board);
    click('.re-browse');
    await vi.waitFor(() => expect(board.opens).toBe(1));
    e.destroy();
    expect(board.closes).toBeGreaterThan(0);
  });

  it('states the IP cost at both opt-ins, not only in About', () => {
    const board = fakeBoard();
    entry(board);
    const notes = [...container.querySelectorAll('.re-note')].map((n) => n.textContent ?? '');
    expect(notes).toHaveLength(2); // under the public/private choice, and under Browse
    for (const n of notes) expect(n).toMatch(/IP address/);
  });

  it('creates a PRIVATE room by default', () => {
    const board = fakeBoard();
    const { onSubmit } = entry(board, 0);
    click('.re-create');
    expect(onSubmit).toHaveBeenCalledWith(expect.any(String), true, false);
  });

  it('creates a public room only after the player picks Public', () => {
    const board = fakeBoard();
    const { onSubmit } = entry(board, 0);
    container.querySelector<HTMLElement>('.vis-chip[data-pub="1"]')!.click();
    click('.re-create');
    expect(onSubmit).toHaveBeenCalledWith(expect.any(String), true, true);
  });

  it('lists host, note, players and whether a round is running', async () => {
    const board = fakeBoard();
    entry(board);
    click('.re-browse');
    await vi.waitFor(() => expect(board.opens).toBe(1));
    board.push([
      { code: 'ABCD', host: 'Ann', players: 2, max: 4, playing: false, note: 'Bloom', seenAt: 0 },
      { code: 'WXYZ', host: 'Bo', players: 4, max: 4, playing: true, note: 'Skirmish', seenAt: 0 },
    ]);

    const rows = [...container.querySelectorAll('.re-room')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Ann');
    expect(rows[0].textContent).toContain('Bloom');
    expect(rows[0].textContent).toContain('2/4');
    expect(rows[0].querySelector('.re-room-state')).toBeNull();
    expect(rows[1].querySelector('.re-room-state')!.textContent).toMatch(/in progress/i);
  });

  it('does not call the list empty before the mesh has had time to form', async () => {
    const board = fakeBoard();
    entry(board, 3000);
    click('.re-browse');
    // open() resolves as soon as we are ON the board, which is not the same as
    // being connected to anyone on it — the mesh forms through a public relay
    // and takes seconds. Saying "nobody is there" here is a lie the player acts
    // on: they tap Back and never see the room that was advertising all along.
    await vi.waitFor(() => expect(board.opens).toBe(1));
    expect(container.querySelector('.re-empty')).toBeNull();
    expect(container.querySelector('.spinner')).toBeTruthy();

    board.push([{ code: 'ABCD', host: 'Ann', players: 1, max: 4, playing: false, seenAt: 0 }]);
    // A room arriving proves the mesh is up, so the wait ends early.
    expect(container.querySelector('.re-room')).toBeTruthy();
  });

  it('says plainly when nobody is hosting, and offers Create', async () => {
    const board = fakeBoard();
    entry(board);
    click('.re-browse');
    await vi.waitFor(() => expect(container.querySelector('.re-empty')).toBeTruthy());
    expect(container.querySelector('.re-empty')!.textContent).toMatch(
      /Nobody has a public room open right now/,
    );
    expect(container.querySelector('.re-make')).toBeTruthy();
  });

  it('joins a room off the list as a GUEST, never claiming host', async () => {
    const board = fakeBoard();
    const { onSubmit } = entry(board, 0);
    click('.re-browse');
    await vi.waitFor(() => expect(board.opens).toBe(1));
    board.push([
      { code: 'ABCD', host: 'Ann', players: 2, max: 4, playing: false, seenAt: 0 },
    ]);
    click('.re-room');

    // created=false is what openRoom() turns into claimHost:false. Claiming host
    // on a stranger's room would fight the incumbent for a room we just found.
    expect(onSubmit).toHaveBeenCalledWith('ABCD', false, false);
    // And we are off the board on the way out — the list was for finding a room,
    // not for staying meshed with everyone who was browsing.
    expect(board.closes).toBeGreaterThan(0);
  });

  it('joins a typed code as a guest even with Public selected', () => {
    const board = fakeBoard();
    const { onSubmit } = entry(board, 0);
    container.querySelector<HTMLElement>('.vis-chip[data-pub="1"]')!.click();
    const input = container.querySelector<HTMLInputElement>('.re-input')!;
    input.value = 'K7QP';
    container.querySelector<HTMLFormElement>('.re-join')!.dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    // You cannot list someone else's room, so the flag cannot ride along.
    expect(onSubmit).toHaveBeenCalledWith('K7QP', false, false);
  });
});
