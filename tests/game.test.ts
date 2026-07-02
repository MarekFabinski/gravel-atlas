import { describe, it, expect } from 'vitest';
import { rideXp, levelForXp, xpForLevel, titleForLevel, sat } from '@/lib/game';

describe('rideXp', () => {
  it('pays 1 XP per km ridden', () => expect(rideXp(30000, 0)).toBe(30));
  it('pays 8 XP per new-segment km on top', () => expect(rideXp(30000, 5000)).toBe(70));
  it('rounds to nearest integer', () => expect(rideXp(1400, 0)).toBe(1));
  it('never returns negative', () => expect(rideXp(0, 0)).toBe(0));
});

describe('levels', () => {
  it('starts at level 1 with 0 XP', () => expect(levelForXp(0)).toBe(1));
  it('reaches level 2 at exactly 100 XP', () => {
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
  });
  it('reaches level 3 at 400 XP', () => expect(levelForXp(400)).toBe(3));
  it('xpForLevel gives the threshold levelForXp uses', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(3)).toBe(400);
    expect(levelForXp(xpForLevel(5))).toBe(5);
  });
});

describe('titleForLevel', () => {
  it('gives the starting title at level 1', () => expect(titleForLevel(1)).toBe('Fresh Legs'));
  it('gives the highest earned title', () => expect(titleForLevel(13)).toBe('Forest Track Regular'));
  it('caps at the last title', () => expect(titleForLevel(99)).toBe('Master of the Grey Roads'));
});

describe('sat', () => {
  it('is 0 at 0', () => expect(sat(0, 100)).toBe(0));
  it('is 0.5 at k', () => expect(sat(100, 100)).toBe(0.5));
  it('approaches 1', () => expect(sat(10000, 100)).toBeGreaterThan(0.98));
});
