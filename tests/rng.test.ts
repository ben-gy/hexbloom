/**
 * P2P-sync invariant: two peers seeded identically must produce byte-identical
 * streams, shuffles, and picks — plus (Hexbloom-specific) identical boards.
 * Adapted from the gh-game-factory patterns/tests template.
 */
import { describe, expect, it } from 'vitest';
import { makeRng, hashSeed, randInt, shuffle, pick } from '@ben-gy/game-engine/rng';
import { generateBoard } from '../src/game';

describe('makeRng determinism (P2P sync invariant)', () => {
  it('produces an identical stream for the same numeric seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces an identical stream for the same string seed', () => {
    const a = makeRng('room-AB12');
    const b = makeRng('room-AB12');
    expect(Array.from({ length: 50 }, () => a())).toEqual(Array.from({ length: 50 }, () => b()));
  });

  it('diverges for different seeds', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    expect(a()).not.toEqual(b());
  });

  it('stays within [0,1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashSeed', () => {
  it('is stable and unsigned 32-bit', () => {
    const h = hashSeed('hello');
    expect(h).toBe(hashSeed('hello'));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('shuffle / randInt / pick are deterministic per seed', () => {
  it('shuffles identically across two peers', () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const p1 = shuffle(makeRng('seed'), deck);
    const p2 = shuffle(makeRng('seed'), deck);
    expect(p1).toEqual(p2);
    expect([...p1].sort((x, y) => x - y)).toEqual(deck);
    expect(p1).not.toEqual(deck);
  });

  it('randInt stays in range and matches across peers', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const x = randInt(a, 1, 6);
      expect(randInt(b, 1, 6)).toBe(x);
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(6);
    }
  });

  it('pick agrees across peers', () => {
    const opts = ['red', 'green', 'blue', 'gold'];
    const a = makeRng('x');
    const b = makeRng('x');
    expect(pick(a, opts)).toBe(pick(b, opts));
  });
});

describe('board generation is deterministic (peers agree)', () => {
  it('two peers build byte-identical boards from the same seed', () => {
    for (const players of [2, 3, 4]) {
      const a = generateBoard(0xc0ffee, { players });
      const b = generateBoard(0xc0ffee, { players });
      expect(a.tile).toEqual(b.tile);
      expect(a.owner).toEqual(b.owner);
      expect(a.color).toEqual(b.color);
    }
  });

  it('different seeds give different boards', () => {
    const a = generateBoard(1, { players: 2 });
    const b = generateBoard(2, { players: 2 });
    expect(a.tile).not.toEqual(b.tile);
  });

  it('string seeds also agree', () => {
    const a = generateBoard('ROOM-9', { players: 4 });
    const b = generateBoard('ROOM-9', { players: 4 });
    expect(a.tile).toEqual(b.tile);
    expect(a.owner).toEqual(b.owner);
  });
});
