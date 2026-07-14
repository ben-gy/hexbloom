/**
 * Room-code canonicalization. A friend can TYPE the code instead of opening the
 * invite link, so a hand-typed code (lower-case, with stray spaces/dashes) must
 * normalize to the exact same Trystero room id the link carries — or the two
 * players silently land in different rooms.
 */
import { describe, expect, it } from 'vitest';
import { normalizeRoomCode } from '../src/engine/lobby';

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
