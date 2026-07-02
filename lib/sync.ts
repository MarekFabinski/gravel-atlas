const RIDE_TYPES = new Set(['Ride', 'GravelRide', 'MountainBikeRide', 'EBikeRide', 'EMountainBikeRide']);

export function latlngToLineString(latlng: [number, number][]): string {
  return JSON.stringify({
    type: 'LineString',
    coordinates: latlng.map(([lat, lon]) => [lon, lat]),
  });
}

export function isImportable(a: { sport_type: string }): boolean {
  return RIDE_TYPES.has(a.sport_type);
}
