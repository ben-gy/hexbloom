/**
 * Room-code canonicalization. A friend can TYPE the code instead of opening the
 * invite link, so a hand-typed code (lower-case, with stray spaces/dashes) must
 * normalize to the exact same Trystero room id the link carries — or the two
 * players silently land in different rooms.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearRoomInUrl, inviteLink, normalizeRoomCode, setRoomInUrl } from '../src/engine/lobby';

describe('normalizeRoomCode', () => {
  it('upper-cases so a typed code matches the host link', () => {
    expect(normalizeRoomCode('k7qp')).toBe('K7QP');
  });

  it('strips spaces, dashes and punctuation', () => {
    expect(normalizeRoomCode(' k7-qp ')).toBe('K7QP');
    expect(normalizeRoomCode('K7 QP')).toBe('K7QP');
  });

  it('drops non-alphanumerics and caps at 8 chars', () => {
    expect(normalizeRoomCode('abcdefghij')).toBe('ABCDEFGH');
    expect(normalizeRoomCode('a!@#b$%^c')).toBe('ABC');
  });

  it('is idempotent — a link code normalizes to itself', () => {
    const c = normalizeRoomCode('Mint9Z');
    expect(normalizeRoomCode(c)).toBe(c);
  });
});

describe('the room code in the URL', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
  });

  it('carries the code into the invite link', () => {
    setRoomInUrl('K7QP');
    expect(new URL(location.href).searchParams.get('room')).toBe('K7QP');
    expect(inviteLink('K7QP')).toContain('room=K7QP');
  });

  it('drops the code on the way out of the room', () => {
    // Without this the code outlives the session: reopening the page — from
    // history, or the home-screen icon — silently rejoins a room you left, and
    // there is no way to start a fresh one. "It always spawns the same game room."
    setRoomInUrl('K7QP');
    clearRoomInUrl();
    expect(new URL(location.href).searchParams.has('room')).toBe(false);
  });

  it('leaves an unrelated query string alone', () => {
    history.replaceState(null, '', '/?utm=x&room=K7QP');
    clearRoomInUrl();
    const url = new URL(location.href);
    expect(url.searchParams.has('room')).toBe(false);
    expect(url.searchParams.get('utm')).toBe('x');
  });
});
