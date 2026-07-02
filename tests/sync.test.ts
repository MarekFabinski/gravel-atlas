import { describe, it, expect } from 'vitest';
import { latlngToLineString, isImportable } from '@/lib/sync';

describe('latlngToLineString', () => {
  it('swaps Strava [lat,lon] into GeoJSON [lon,lat]', () => {
    const json = latlngToLineString([[54.4, 16.9], [54.41, 16.91]]);
    expect(JSON.parse(json)).toEqual({
      type: 'LineString',
      coordinates: [[16.9, 54.4], [16.91, 54.41]],
    });
  });
});

describe('isImportable', () => {
  it('accepts bike rides', () => {
    for (const t of ['Ride', 'GravelRide', 'MountainBikeRide', 'EBikeRide']) {
      expect(isImportable({ sport_type: t })).toBe(true);
    }
  });
  it('rejects everything else', () => {
    for (const t of ['Run', 'Walk', 'VirtualRide', 'Swim']) {
      expect(isImportable({ sport_type: t })).toBe(false);
    }
  });
});
