const PAVED = new Set([
  'asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes',
  'paving_stones', 'sett',
]);
const UNPAVED = new Set([
  'gravel', 'fine_gravel', 'compacted', 'unpaved', 'dirt', 'ground',
  'earth', 'sand', 'grass', 'mud', 'pebblestone', 'wood',
]);
const PAVED_HIGHWAYS = new Set([
  'residential', 'tertiary', 'secondary', 'living_street', 'cycleway',
]);
const UNPAVED_HIGHWAYS = new Set(['track', 'path', 'bridleway']);

export function classifySurface(tags: Record<string, string>): 'paved' | 'unpaved' | 'unknown' {
  const s = tags.surface;
  if (s) {
    if (PAVED.has(s)) return 'paved';
    if (UNPAVED.has(s)) return 'unpaved';
    return 'unknown';
  }
  const h = tags.highway ?? '';
  if (UNPAVED_HIGHWAYS.has(h)) return 'unpaved';
  if (PAVED_HIGHWAYS.has(h)) return 'paved';
  return 'unknown';
}
