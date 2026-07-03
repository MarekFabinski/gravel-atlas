import { XP_PER_RIDE_KM, XP_PER_NEW_SEGMENT_KM } from './config';

export function rideXp(distanceM: number, newSegmentM: number): number {
  return Math.round(
    (distanceM / 1000) * XP_PER_RIDE_KM + (newSegmentM / 1000) * XP_PER_NEW_SEGMENT_KM
  );
}

export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export function xpForLevel(level: number): number {
  return (level - 1) ** 2 * 100;
}

export const TITLES: [number, string][] = [
  [1, 'Fresh Legs'],
  [3, 'Wanderer of Reblino'],
  [6, 'Gravel Apprentice'],
  [9, 'Słupia Valley Scout'],
  [12, 'Forest Track Regular'],
  [16, 'Baltic Wind Rider'],
  [20, 'Pomeranian Pathfinder'],
  [26, 'Master of the Grey Roads'],
];

export function titleForLevel(level: number): string {
  let title = TITLES[0][1];
  for (const [minLevel, t] of TITLES) {
    if (level >= minLevel) title = t;
  }
  return title;
}

/** Saturation curve for radar axes: 0 → 0, k → 0.5, ∞ → 1. */
export function sat(value: number, k: number): number {
  return value / (value + k);
}
