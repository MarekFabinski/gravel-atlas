export const BUFFER_M = 20;
export const COVERAGE_MIN = 0.7;
export const XP_PER_RIDE_KM = 1;
export const XP_PER_NEW_SEGMENT_KM = 8;

/**
 * OSM highway values that make up the game board. `service` is deliberately
 * absent (driveways, parking aisles, alleys — dropped 2026-07-05; see
 * docs/superpowers/specs/2026-07-05-drop-service-roads-design.md).
 */
export const RIDEABLE_HIGHWAYS = [
  'track', 'path', 'bridleway', 'unclassified', 'tertiary', 'secondary',
  'residential', 'cycleway', 'living_street',
];
